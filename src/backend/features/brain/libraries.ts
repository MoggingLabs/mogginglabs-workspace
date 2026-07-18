import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { BrainLibDep, BrainLibEcosystem } from '@contracts'

// Version truth (ADR 0018 step 08): which EXACT third-party versions this
// project runs — from the LOCKFILES, deterministically, offline. Direct deps
// carry their manifest role; transitives are listed, never doc-indexed.
// Manifest-only projects degrade honestly: ranges are reported AS ranges with
// `pinned: false` — nothing here ever resolves a range by guesswork. Installed
// truth comes from the bytes on disk (node_modules / site-packages metadata),
// READ ONLY: no package code ever executes, no require(), no scripts.
//
// Every parser is tolerant — a malformed file contributes nothing rather than
// throwing — and pure on bytes, so the same lockfile always yields the same
// rows (the BRAINDOCS gate's determinism arm rides on that).

/** npm names that may be joined to node_modules on disk. Anything else is
 *  still a db KEY (listed honestly) but never becomes a filesystem path. */
const SAFE_NPM_NAME = /^(@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/i
/** py names safe to look up in site-packages. */
const SAFE_PY_NAME = /^[A-Za-z0-9_.-]+$/

const read = (root: string, rel: string): string | null => {
  try {
    return readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

const jsonOf = (text: string | null): Record<string, unknown> | null => {
  if (!text) return null
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

interface RawDep {
  ecosystem: BrainLibEcosystem
  name: string
  version: string
  pinned: boolean
  direct: boolean
}

/** Merge rule: first writer wins per (ecosystem, name) — lock truth lands
 *  before manifest fallbacks, so a pinned row is never downgraded to a range. */
function addDep(map: Map<string, RawDep>, dep: RawDep): void {
  if (!dep.name) return
  const key = `${dep.ecosystem}\0${dep.name}`
  const prior = map.get(key)
  if (!prior) {
    map.set(key, dep)
    return
  }
  if (dep.direct && !prior.direct) prior.direct = true // the manifest names it: direct
}

// ── npm ──────────────────────────────────────────────────────────────────────

function npmManifestDeps(root: string): Map<string, string> {
  const pkg = jsonOf(read(root, 'package.json'))
  const out = new Map<string, string>()
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkg?.[field]
    if (typeof block === 'object' && block !== null) {
      for (const [name, range] of Object.entries(block as Record<string, unknown>)) {
        if (typeof range === 'string' && !out.has(name)) out.set(name, range)
      }
    }
  }
  return out
}

function parsePackageLock(text: string, direct: Set<string>, map: Map<string, RawDep>): boolean {
  const lock = jsonOf(text)
  if (!lock) return false
  let any = false
  const packages = lock.packages
  if (typeof packages === 'object' && packages !== null) {
    // v2/v3: keys are install paths. Top-level installs only — a nested
    // "node_modules/a/node_modules/b" is a conflict copy, not the resolution.
    for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
      if (!key.startsWith('node_modules/')) continue
      const name = key.slice('node_modules/'.length)
      if (name.includes('node_modules/')) continue
      const version = (entry as { version?: unknown } | null)?.version
      if (typeof version !== 'string' || !version) continue
      addDep(map, { ecosystem: 'npm', name, version, pinned: true, direct: direct.has(name) })
      any = true
    }
    if (any) return true
  }
  const v1 = lock.dependencies
  if (typeof v1 === 'object' && v1 !== null) {
    for (const [name, entry] of Object.entries(v1 as Record<string, unknown>)) {
      const version = (entry as { version?: unknown } | null)?.version
      if (typeof version !== 'string' || !version) continue
      addDep(map, { ecosystem: 'npm', name, version, pinned: true, direct: direct.has(name) })
      any = true
    }
  }
  return any
}

/** pnpm-lock v6 dep entries are { version: "1.2.3(peer)" }; older are plain strings. */
const pnpmVersionOf = (v: unknown): string | null => {
  const raw = typeof v === 'string' ? v : (v as { version?: unknown } | null)?.version
  if (typeof raw !== 'string' || !raw) return null
  const bare = raw.split('(')[0]
  return /^\d/.test(bare) ? bare : null // "link:.." and friends are not versions
}

/** A pnpm packages key: "/name@1.2.3(peers)" (v6) or "name@1.2.3" (v9+). */
function pnpmPackageKey(key: string): { name: string; version: string } | null {
  const k = key.startsWith('/') ? key.slice(1) : key
  const at = k.startsWith('@') ? k.indexOf('@', 1) : k.indexOf('@')
  if (at <= 0) return null
  const name = k.slice(0, at)
  const version = k.slice(at + 1).split('(')[0]
  return /^\d/.test(version) ? { name, version } : null
}

function parsePnpmLock(text: string, direct: Set<string>, map: Map<string, RawDep>): boolean {
  let lock: Record<string, unknown> | null = null
  try {
    const v = parseYaml(text) as unknown
    lock = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return false
  }
  if (!lock) return false
  let any = false
  const importerBlocks: Record<string, unknown>[] = []
  const importers = lock.importers
  if (typeof importers === 'object' && importers !== null) {
    for (const block of Object.values(importers as Record<string, unknown>)) {
      if (typeof block === 'object' && block !== null) importerBlocks.push(block as Record<string, unknown>)
    }
  } else {
    importerBlocks.push(lock) // no-workspace layout: deps sit at the top level
  }
  for (const block of importerBlocks) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = block[field]
      if (typeof deps !== 'object' || deps === null) continue
      for (const [name, v] of Object.entries(deps as Record<string, unknown>)) {
        const version = pnpmVersionOf(v)
        if (!version) continue
        // Importer entries ARE the manifest's own deps — direct by construction.
        addDep(map, { ecosystem: 'npm', name, version, pinned: true, direct: true })
        any = true
      }
    }
  }
  const packages = lock.packages
  if (typeof packages === 'object' && packages !== null) {
    for (const key of Object.keys(packages as Record<string, unknown>)) {
      const parsed = pnpmPackageKey(key)
      if (!parsed) continue
      addDep(map, { ecosystem: 'npm', name: parsed.name, version: parsed.version, pinned: true, direct: direct.has(parsed.name) })
      any = true
    }
  }
  return any
}

/** yarn.lock, both dialects, line-scanned: an entry header names selectors
 *  ("name@range", comma-separated, possibly quoted, berry adds npm:); the
 *  first following `version` line is the resolution. */
function parseYarnLock(text: string, direct: Set<string>, map: Map<string, RawDep>): boolean {
  let any = false
  let pendingNames: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line) && line.trimEnd().endsWith(':')) {
      const header = line.trim().slice(0, -1)
      if (header === '__metadata') {
        pendingNames = []
        continue
      }
      pendingNames = header
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .map((sel) => {
          const at = sel.startsWith('@') ? sel.indexOf('@', 1) : sel.indexOf('@')
          return at > 0 ? sel.slice(0, at) : ''
        })
        .filter(Boolean)
      continue
    }
    if (pendingNames.length) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line)
      if (m) {
        for (const name of new Set(pendingNames)) {
          addDep(map, { ecosystem: 'npm', name, version: m[1], pinned: true, direct: direct.has(name) })
          any = true
        }
        pendingNames = []
      }
    }
  }
  return any
}

// ── python ───────────────────────────────────────────────────────────────────

/** requirements.txt lines — every entry is DIRECT by definition. `==`/`===`
 *  pins; any other spec is an honest range. */
function parseRequirements(text: string, map: Map<string, RawDep>): void {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line || line.startsWith('-') || /^https?:\/\//.test(line)) continue
    const m = /^([A-Za-z0-9_.-]+)(\[[^\]]*\])?\s*(===|==|>=|<=|~=|!=|>|<)?\s*([^;\s]*)/.exec(line)
    if (!m) continue
    const [, name, , op, rest] = m
    if (op === '==' || op === '===') {
      addDep(map, { ecosystem: 'py', name, version: rest, pinned: true, direct: true })
    } else {
      addDep(map, { ecosystem: 'py', name, version: op ? `${op}${rest}` : '', pinned: false, direct: true })
    }
  }
}

/** [[package]] name/version blocks — poetry.lock and uv.lock share the shape. */
function parseTomlPackages(text: string, ecosystem: BrainLibEcosystem, direct: Set<string>, map: Map<string, RawDep>): boolean {
  let any = false
  for (const block of text.split('[[package]]').slice(1)) {
    const name = /\bname\s*=\s*"([^"]+)"/.exec(block)?.[1]
    const version = /\bversion\s*=\s*"([^"]+)"/.exec(block)?.[1]
    if (!name || !version) continue
    addDep(map, { ecosystem, name, version, pinned: true, direct: direct.has(normalizePyName(name)) })
    any = true
  }
  return any
}

const normalizePyName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Direct py names from pyproject.toml: PEP 621 [project] dependencies plus
 *  poetry's [tool.poetry.dependencies] table. Regex-scoped, never evaluated. */
function pyDirectNames(root: string): Set<string> {
  const out = new Set<string>()
  const text = read(root, 'pyproject.toml')
  if (!text) return out
  const depArray = /\bdependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1]
  if (depArray) {
    for (const m of depArray.matchAll(/"([A-Za-z0-9_.-]+)[^"]*"/g)) out.add(normalizePyName(m[1]))
  }
  const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1]
  if (poetry) {
    for (const line of poetry.split('\n')) {
      const m = /^([A-Za-z0-9_.-]+)\s*=/.exec(line.trim())
      if (m && m[1].toLowerCase() !== 'python') out.add(normalizePyName(m[1]))
    }
  }
  return out
}

// ── go ───────────────────────────────────────────────────────────────────────

function parseGoMod(text: string, map: Map<string, RawDep>): void {
  const entry = (line: string): void => {
    const m = /^([^\s]+)\s+(v[^\s]+)(.*)$/.exec(line.trim())
    if (!m) return
    addDep(map, { ecosystem: 'go', name: m[1], version: m[2], pinned: true, direct: !/\/\/\s*indirect/.test(m[3]) })
  }
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)\)/gm)) {
    for (const line of block[1].split('\n')) if (line.trim()) entry(line)
  }
  for (const single of text.matchAll(/^require\s+([^\s(][^\n]*)$/gm)) entry(single[1])
}

// ── cargo ────────────────────────────────────────────────────────────────────

/** Direct crate names from Cargo.toml's dependency sections. */
function cargoDirectNames(root: string): Set<string> {
  const out = new Set<string>()
  const text = read(root, 'Cargo.toml')
  if (!text) return out
  for (const m of text.matchAll(/\[(?:dependencies|dev-dependencies|build-dependencies)\]([\s\S]*?)(?=\n\[|$)/g)) {
    for (const line of m[1].split('\n')) {
      const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line.trim())
      if (key) out.add(key[1])
    }
  }
  return out
}

// ── installed truth (disk metadata only — never executes anything) ───────────

function npmInstalledVersion(root: string, name: string): string {
  if (!SAFE_NPM_NAME.test(name)) return ''
  const pkg = jsonOf(read(root, path.join('node_modules', ...name.split('/'), 'package.json').replace(/\\/g, '/')))
  return typeof pkg?.version === 'string' ? pkg.version : ''
}

/** site-packages candidates under the project's own venv layouts. */
function sitePackagesDirs(root: string): string[] {
  const out: string[] = []
  for (const venv of ['.venv', 'venv']) {
    out.push(path.join(root, venv, 'Lib', 'site-packages')) // Windows layout
    const lib = path.join(root, venv, 'lib')
    try {
      for (const entry of readdirSync(lib)) {
        if (/^python\d/.test(entry)) out.push(path.join(lib, entry, 'site-packages'))
      }
    } catch {
      /* no posix layout here */
    }
  }
  return out
}

/** The dist-info dirname is the ONE trustworthy installed-version witness. */
function pyInstalledVersion(siteDirs: string[], name: string): string {
  if (!SAFE_PY_NAME.test(name)) return ''
  const normalized = normalizePyName(name)
  for (const dir of siteDirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const m = /^([A-Za-z0-9_.-]+)-([^-]+)\.dist-info$/.exec(entry)
      if (m && normalizePyName(m[1]) === normalized) return m[2]
    }
  }
  return ''
}

// ── the resolve ──────────────────────────────────────────────────────────────

/**
 * The whole answer for one partition root: lockfile truth first, manifest
 * ranges for anything unpinned, installed truth stamped from disk metadata.
 * Deterministic on the bytes; tolerant of every malformed input.
 */
export function resolveLibraries(root: string): BrainLibDep[] {
  const map = new Map<string, RawDep>()

  // npm: one lock wins (package-lock > pnpm > yarn); the manifest fills gaps.
  const npmDirect = npmManifestDeps(root)
  const directNames = new Set(npmDirect.keys())
  const npmLock = read(root, 'package-lock.json')
  const pnpm = npmLock ? null : read(root, 'pnpm-lock.yaml')
  const yarn = npmLock || pnpm ? null : read(root, 'yarn.lock')
  if (npmLock) parsePackageLock(npmLock, directNames, map)
  else if (pnpm) parsePnpmLock(pnpm, directNames, map)
  else if (yarn) parseYarnLock(yarn, directNames, map)
  for (const [name, range] of npmDirect) {
    // A direct dep the lock does not pin (or no lock at all): the honest range.
    // Already-pinned names only gain the direct mark — first writer wins.
    addDep(map, { ecosystem: 'npm', name, version: range, pinned: false, direct: true })
  }

  // python: a lock's exact pins + requirements' own entries.
  const pyDirect = pyDirectNames(root)
  const uv = read(root, 'uv.lock')
  const poetry = uv ? null : read(root, 'poetry.lock')
  if (uv) parseTomlPackages(uv, 'py', pyDirect, map)
  else if (poetry) parseTomlPackages(poetry, 'py', pyDirect, map)
  const reqs = read(root, 'requirements.txt')
  if (reqs) parseRequirements(reqs, map)

  // go + cargo.
  const gomod = read(root, 'go.mod')
  if (gomod) parseGoMod(gomod, map)
  const cargoLock = read(root, 'Cargo.lock')
  if (cargoLock) parseTomlPackages(cargoLock, 'cargo', cargoDirectNames(root), map)

  // Installed truth: the PINNED version on disk is `installed`; what the disk
  // actually holds rides `installedVersion` either way ('' = absent).
  const siteDirs = sitePackagesDirs(root)
  const out: BrainLibDep[] = []
  for (const dep of map.values()) {
    let installedVersion = ''
    if (dep.ecosystem === 'npm') installedVersion = npmInstalledVersion(root, dep.name)
    else if (dep.ecosystem === 'py') installedVersion = pyInstalledVersion(siteDirs, dep.name)
    const installed = installedVersion !== '' && (!dep.pinned || installedVersion === dep.version)
    out.push({ ...dep, installed, installedVersion })
  }
  out.sort((a, b) =>
    a.ecosystem !== b.ecosystem
      ? a.ecosystem < b.ecosystem ? -1 : 1
      : a.direct !== b.direct
        ? a.direct ? -1 : 1
        : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )
  return out
}

export { SAFE_NPM_NAME, SAFE_PY_NAME, normalizePyName }
