import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import {
  BRAIN_LIBDOC_README_CAP,
  BRAIN_LIBDOC_SCAN_CAP,
  BRAIN_LIBDOC_SIG_CAP,
  type BrainLibDep
} from '@contracts'
import { extractPortable } from './extract'
import type { ParserPool } from './parser-pool'
import { SAFE_NPM_NAME, SAFE_PY_NAME, normalizePyName } from './libraries'
import type { BrainLibDocDbRow } from './store'

// Docs from DISK (ADR 0018 step 08): distill what is already INSTALLED — the
// README, the manifest's export surface, and the bundled .d.ts reduced to
// signature lines through the same WASM ts grammar the graph uses; python gets
// its top-level docstring. READ ONLY, worker-side, zero network by
// construction: no require(), no install hooks, no scripts — reading files is
// the whole mechanism. Rows are keyed (ecosystem, name, version) where version
// is what the DISK holds, so an answer can never claim a release it hasn't
// seen. Direct deps only, scan-capped; transitives are listed, never doc-indexed.

const capText = (text: string, cap: number): { text: string; truncated: boolean } =>
  text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false }

/** The dir's README, case-tolerant, first of the conventional spellings. */
function readReadme(dir: string): string {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return ''
  }
  const candidates = entries
    .filter((e) => /^readme(\.(md|markdown|txt|rst))?$/i.test(e))
    .sort((a, b) => a.length - b.length) // README.md beats README.long-variant.md
  for (const entry of candidates) {
    try {
      return readFileSync(path.join(dir, entry), 'utf8')
    } catch {
      /* try the next spelling */
    }
  }
  return ''
}

/** A package-relative file reference resolved WITHIN the package dir — a
 *  types field pointing outside it is refused, not followed. */
function insidePackage(dir: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null
  const abs = path.resolve(dir, rel)
  const base = path.resolve(dir) + path.sep
  return abs.startsWith(base) ? abs : null
}

/** Bundled .d.ts → signature lines via the ts grammar. Parse failure = no
 *  signatures, honestly — never a throw, never a guess. */
async function distillTypes(pool: ParserPool, absDts: string): Promise<string[]> {
  try {
    const parsed = await pool.parseFile(absDts, 'typescript')
    if (!parsed.ok) return []
    const query = pool.queryFor('typescript')
    const ex = query ? extractPortable(query, parsed.tree, 'typescript') : null
    parsed.tree.delete()
    if (!ex) return []
    const sigs: string[] = []
    const seen = new Set<string>()
    for (const def of ex.defs) {
      if (!def.sig || seen.has(def.sig)) continue
      seen.add(def.sig)
      sigs.push(def.sig)
      if (sigs.length >= BRAIN_LIBDOC_SIG_CAP) break
    }
    return sigs
  } catch {
    return []
  }
}

function npmDocRow(dir: string): { readme: string; exports: string[]; typesRel: string | null } {
  let pkg: Record<string, unknown> = {}
  try {
    const v = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as unknown
    if (typeof v === 'object' && v !== null) pkg = v as Record<string, unknown>
  } catch {
    /* manifest unreadable — README may still exist */
  }
  const exports: string[] = []
  if (typeof pkg.exports === 'object' && pkg.exports !== null) {
    for (const key of Object.keys(pkg.exports as Record<string, unknown>).slice(0, 40)) exports.push(key)
  } else if (typeof pkg.main === 'string') exports.push(pkg.main)
  const typesField = typeof pkg.types === 'string' ? pkg.types : typeof pkg.typings === 'string' ? (pkg.typings as string) : 'index.d.ts'
  return { readme: readReadme(dir), exports, typesRel: typesField }
}

/** First module-level docstring of a python package's __init__.py (or the
 *  single-file module), matched textually — never imported, never executed. */
function pyDocstring(siteDirs: string[], name: string): { text: string; found: boolean } {
  const normalized = normalizePyName(name).replace(/-/g, '_')
  for (const dir of siteDirs) {
    for (const candidate of [path.join(dir, normalized, '__init__.py'), path.join(dir, `${normalized}.py`)]) {
      let text: string
      try {
        text = readFileSync(candidate, 'utf8')
      } catch {
        continue
      }
      const m = /^(?:\s|#[^\n]*\n)*(?:[rRuUbB]{0,2})("""|''')([\s\S]*?)\1/.exec(text)
      return { text: m ? m[2].trim() : '', found: true }
    }
  }
  return { text: '', found: false }
}

/** site-packages candidates — the resolver's rule, restated worker-side. */
function sitePackagesDirs(root: string): string[] {
  const out: string[] = []
  for (const venv of ['.venv', 'venv']) {
    out.push(path.join(root, venv, 'Lib', 'site-packages'))
    const lib = path.join(root, venv, 'lib')
    try {
      for (const entry of readdirSync(lib)) {
        if (/^python\d/.test(entry)) out.push(path.join(lib, entry, 'site-packages'))
      }
    } catch {
      /* no posix layout */
    }
  }
  return out
}

/**
 * Distill docs for every DIRECT dep whose bytes are on disk, capped at
 * BRAIN_LIBDOC_SCAN_CAP. The row's version is the INSTALLED version — the one
 * truth the bytes can testify to.
 */
export async function scanLibraryDocs(pool: ParserPool, root: string, deps: BrainLibDep[]): Promise<BrainLibDocDbRow[]> {
  const rows: BrainLibDocDbRow[] = []
  const siteDirs = sitePackagesDirs(root)
  let scanned = 0
  for (const dep of deps) {
    // The reference law: docs land only for a version some lockfile references —
    // the pinned version when it is the one on disk, or whatever the disk holds
    // for an honestly-unpinned range. A pinned-but-mismatched install lands
    // nothing: its docs would describe a version the project no longer runs.
    if (!dep.direct || !dep.installedVersion) continue
    if (dep.pinned && !dep.installed) continue
    if (scanned >= BRAIN_LIBDOC_SCAN_CAP) break
    if (dep.ecosystem === 'npm') {
      if (!SAFE_NPM_NAME.test(dep.name)) continue
      scanned += 1
      const dir = path.join(root, 'node_modules', ...dep.name.split('/'))
      let realDir = dir
      try {
        realDir = realpathSync.native(dir) // pnpm layouts symlink here; docs live at the target
      } catch {
        continue
      }
      const { readme, exports, typesRel } = npmDocRow(realDir)
      const absDts = typesRel ? insidePackage(realDir, typesRel) : null
      const sigs = absDts && /\.ts$/.test(absDts) ? await distillTypes(pool, absDts) : []
      const capped = capText(readme, BRAIN_LIBDOC_README_CAP)
      if (!capped.text && !sigs.length && !exports.length) continue
      rows.push({
        ecosystem: 'npm',
        name: dep.name,
        version: dep.installedVersion,
        source: 'disk',
        readme: capped.text,
        signatures: JSON.stringify({ exports, sigs, readmeTruncated: capped.truncated })
      })
    } else if (dep.ecosystem === 'py') {
      if (!SAFE_PY_NAME.test(dep.name)) continue
      scanned += 1
      const doc = pyDocstring(siteDirs, dep.name)
      if (!doc.found || !doc.text) continue
      const capped = capText(doc.text, BRAIN_LIBDOC_README_CAP)
      rows.push({
        ecosystem: 'py',
        name: dep.name,
        version: dep.installedVersion,
        source: 'disk',
        readme: capped.text,
        signatures: JSON.stringify({ exports: [], sigs: [], readmeTruncated: capped.truncated })
      })
    }
    // go/cargo: module caches live outside the project — no disk custody here,
    // and the dep row already says installed:false, honestly.
  }
  return rows
}
