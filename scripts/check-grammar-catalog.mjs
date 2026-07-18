#!/usr/bin/env node
// The grammar-catalog gate (GRAMMARCAT) — the offline half of the pair.
//
//   node scripts/check-grammar-catalog.mjs
//   node scripts/check-grammar-catalog.mjs --grammars-dir <dir>   (BRAINPARSE's tamper arm)
//
// THE RULE: every grammar the brain can load is a grammar the operator DELIBERATELY
// pinned — the bytes on disk are the bytes the update script verified, the routing
// table has one owner per extension, the licence is stated, the docs tell the truth
// about the roster, and the whole vendored set stays under its size budget.
//
// ZERO NETWORK, ZERO WASM LOADING: loading + probe-parsing is the UPDATE script's job
// (scripts/update-grammar-catalog.mjs, operator-run) — this gate is bytes and prose,
// so the sweep stays offline and deterministic. Same family as check-gate-count.mjs
// and check-agent-settings-catalog.mjs: a list that must agree with the artifacts and
// the docs beside it, and nothing but a gate ever makes them agree.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG = join(ROOT, 'src/backend/features/brain/grammars.json')
const ADR = join(ROOT, 'docs/adr/0018-workspace-brain.md')
/** ADR 0018.a's affordability budget for the WHOLE vendored set (wasm + queries). */
const TOTAL_BYTES_CAP = 25 * 1024 * 1024

const dirFlag = process.argv.indexOf('--grammars-dir')
const GRAMMARS_DIR = dirFlag > -1 ? resolve(process.argv[dirFlag + 1]) : join(ROOT, 'assets/grammars')
const QUERIES_DIR = join(GRAMMARS_DIR, 'queries')

const bad = []
const fail = (msg) => bad.push(msg)

let catalog
try {
  catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
} catch (e) {
  console.error(`\nGRAMMAR CATALOG: ${CATALOG} unreadable — ${e.message}\n`)
  process.exit(1)
}
const rows = catalog.grammars
if (!Array.isArray(rows) || !rows.length) {
  console.error('\nGRAMMAR CATALOG: no grammar rows — the pattern is blind.\n')
  process.exit(1)
}

// ── Row shape + artifact truth ───────────────────────────────────────────────────
const FIELDS = ['lang', 'wasm', 'sha256', 'version', 'sourceRepo', 'releaseTag', 'extensions', 'licence']
let totalBytes = 0
const langs = new Set()
const wasms = new Set()
const extOwner = new Map()

for (const row of rows) {
  const where = `row '${row?.lang ?? '?'}'`
  for (const f of FIELDS) {
    const v = row?.[f]
    if (v === undefined || v === null || (typeof v === 'string' && !v) || (Array.isArray(v) && !v.length)) {
      fail(`${where}: field '${f}' is missing or empty — the update script pins every field`)
    }
  }
  if (langs.has(row.lang)) fail(`${where}: duplicate lang`)
  langs.add(row.lang)
  if (wasms.has(row.wasm)) fail(`${where}: duplicate wasm filename`)
  wasms.add(row.wasm)
  for (const ext of row.extensions ?? []) {
    if (!/^\.[a-z0-9_]+$/i.test(ext)) fail(`${where}: extension '${ext}' is not a dotted extension`)
    const owner = extOwner.get(ext.toLowerCase())
    if (owner) fail(`extension '${ext}' claimed by both '${owner}' and '${row.lang}' — routing must have ONE owner`)
    extOwner.set(ext.toLowerCase(), row.lang)
  }

  const artifact = join(GRAMMARS_DIR, row.wasm)
  if (!existsSync(artifact)) {
    fail(`${where}: assets/grammars/${row.wasm} MISSING — run npm run catalog:grammars:update`)
    continue
  }
  const bytes = readFileSync(artifact)
  totalBytes += bytes.length
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (row.sha256 && hash !== row.sha256) {
    fail(`${where}: ${row.wasm} sha256 ${hash.slice(0, 12)}… does not match the pinned ${String(row.sha256).slice(0, 12)}… — the artifact drifted from what the update script verified`)
  }

  const queryFile = join(QUERIES_DIR, `${row.lang}.scm`)
  if (!existsSync(queryFile)) fail(`${where}: queries/${row.lang}.scm MISSING — every language ships its tag query`)
  else totalBytes += statSync(queryFile).size
}

// ── No orphans: every artifact on disk is a catalog row's ────────────────────────
try {
  for (const f of readdirSync(GRAMMARS_DIR)) {
    if (f === 'queries') continue
    if (!f.endsWith('.wasm')) fail(`assets/grammars/${f}: stray file — only catalog-named .wasm artifacts live here`)
    else if (!wasms.has(f)) fail(`assets/grammars/${f}: orphan artifact no catalog row names`)
  }
  if (existsSync(QUERIES_DIR)) {
    for (const f of readdirSync(QUERIES_DIR)) {
      const lang = f.replace(/\.scm$/, '')
      if (!f.endsWith('.scm') || !langs.has(lang)) fail(`assets/grammars/queries/${f}: orphan query no catalog row names`)
    }
  }
} catch (e) {
  fail(`assets/grammars unreadable — ${e.message}`)
}

// ── The size budget ──────────────────────────────────────────────────────────────
if (totalBytes > TOTAL_BYTES_CAP) {
  fail(`vendored set is ${(totalBytes / 1048576).toFixed(1)} MB — over the ${(TOTAL_BYTES_CAP / 1048576).toFixed(0)} MB cap (ADR 0018.a: affordability is a contract)`)
}

// ── Roster prose: the ADR's backticked roster IS the catalog, exactly ────────────
const adr = readFileSync(ADR, 'utf8')
const roster = /\*\*Grammar roster \(gated\):\*\*\s*`([^`]+)`/.exec(adr)
if (!roster) {
  fail(`docs/adr/0018-workspace-brain.md: the '**Grammar roster (gated):** \`…\`' line is gone — the doc stopped telling the truth about the roster`)
} else {
  const prose = roster[1].trim().split(/\s+/).sort()
  const actual = [...langs].sort()
  if (prose.join(' ') !== actual.join(' ')) {
    fail(`ADR 0018 roster prose [${prose.join(' ')}] disagrees with the catalog [${actual.join(' ')}]`)
  }
}

if (bad.length) {
  console.error(`\nGRAMMAR CATALOG DRIFT — ${bad.length} finding(s).\n`)
  for (const b of bad) console.error(`  ${b}`)
  console.error('\nThe update script is the only writer; the catalog is the only truth. Fix the row, the artifact, or the prose.\n')
  process.exit(1)
}

console.log(
  `  grammar catalog OK — ${rows.length} languages, ${extOwner.size} extensions routed, ${(totalBytes / 1048576).toFixed(1)} MB of ${(TOTAL_BYTES_CAP / 1048576).toFixed(0)} MB, hashes + roster prose agree`
)
