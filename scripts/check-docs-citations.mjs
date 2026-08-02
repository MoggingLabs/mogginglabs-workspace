#!/usr/bin/env node
// Docs citations, DERIVED from the repo rather than read from prose.
//
// DOCSREFS (check-docs-refs.mjs) already asserts that a cited path EXISTS and that ADR numbers
// are unique. It never compares a LABEL to its target, a NUMBER to its deriver, or a LIST to
// another list — so a doc could name ADR 0015 while linking to 0016, promise a 9-verb scripting
// reference against a 21-verb CLI, or print a column header the CLI stopped emitting.
//
// Every rule below takes its expected value from a repo artifact. None reads prose for truth:
// prose is only ever the thing being checked.
//
// THE INVARIANT THAT MAKES THIS TRUSTWORTHY: no rule may pass by matching nothing. Each carries
// a floor, and falling below it is a loud failure — "the pattern is blind" — never a green.
// This repo has been bitten repeatedly by gates that passed because their scan had rotted
// (check-gate-count.mjs's `blind` array and check-cli-satellites.mjs's two floors are the
// precedents). The per-rule counts are printed on success so a silently shrinking scan is
// visible in the sweep log even while it still passes.

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const read = (p) => readFileSync(join(REPO, p), 'utf8')

const problems = []
const fail = (msg) => problems.push(msg)
/** A rule that scanned nothing has rotted; it must not report success. */
const floor = (rule, n, min) => {
  if (n < min) fail(`${rule} matched ${n} (floor ${min}) — the pattern is blind, not the docs clean`)
  return n
}

const LIVING_DOCS = readdirSync(join(REPO, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `docs/${f}`)

// ── C1 · a chapter's H1 number is its filename's ──────────────────────────────────────────
// `docs/19-accounts.md` opened "# 18 — Accounts…". The filename is the identity; the heading
// is a restatement, and a restatement that disagrees is the one that is wrong.
let c1 = 0
for (const file of LIVING_DOCS) {
  const m = /^(\d\d)-/.exec(file.slice('docs/'.length))
  if (!m) continue
  const h1 = read(file).split('\n').find((l) => l.startsWith('# '))
  if (!h1) continue
  const stated = /^#\s*(\d+)\b/.exec(h1)
  if (!stated) continue // an unnumbered H1 is a style, not a claim
  c1++
  if (stated[1].padStart(2, '0') !== m[1]) {
    fail(`${file}: H1 says chapter ${stated[1]}, the filename says ${m[1]}`)
  }
}
floor('C1 chapter identity', c1, 8)

// ── C2 · an ADR's label is its target's number ────────────────────────────────────────────
// `[0015](adr/0016-accounts-and-entitlements.md)` — the link works, so DOCSREFS is satisfied,
// and the reader is told the wrong ADR.
let c2 = 0
for (const file of [...LIVING_DOCS, 'README.md']) {
  const text = read(file)
  // Both spellings the docs use: `[ADR 0016](adr/…)` and a bare `[0016](docs/adr/…)`.
  for (const m of text.matchAll(/\[(?:ADR\s+)?(\d{4})\]\((?:\.\.\/|docs\/)?adr\/(\d{4})-[^)]*\)/g)) {
    c2++
    if (m[1] !== m[2]) fail(`${file}: link labelled ADR ${m[1]} points at ADR ${m[2]}`)
  }
}
floor('C2 ADR labels', c2, 10)

// ── C6 · the scripting reference lists the verbs the CLI actually dispatches ──────────────
// docs/06 calls its table "the scripting reference". The dispatch is the truth.
const binSrc = read('bin/mogging.mjs')
const verbs = [...new Set([...binSrc.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]))]
floor('C6 CLI verbs', verbs.length, 15)
const controlApi = read('docs/06-control-api.md')
const documented = new Set([...controlApi.matchAll(/`mogging ([a-z-]+)/g)].map((m) => m[1]))
floor('C6 documented verbs', documented.size, 8)
const undocumented = verbs.filter((v) => !documented.has(v))
if (undocumented.length) {
  fail(
    `docs/06-control-api.md does not mention ${undocumented.length} verb(s) the CLI dispatches: ${undocumented.join(', ')}`
  )
}

// ── C7 · the columns docs/06 promises are the columns `mogging list` prints ───────────────
// The CLI grew a REMOTE column; the doc still promised `ID SIZE STATE TITLE`.
const header = /process\.stdout\.write\(line\(([^)]*)\)\)/.exec(binSrc)
if (!header) {
  fail("C7: could not find `mogging list`'s header literal in bin/mogging.mjs — re-anchor this rule")
} else {
  const columns = [...header[1].matchAll(/'([A-Z]+)'/g)].map((m) => m[1])
  floor('C7 list columns', columns.length, 3)
  const promised = /Enumerate live panes: `([^`]+)`/.exec(controlApi)
  if (!promised) fail('C7: docs/06 no longer states the `mogging list` columns — re-anchor this rule')
  else {
    const stated = promised[1].trim().split(/\s+/)
    if (stated.join(' ') !== columns.join(' ')) {
      fail(`docs/06 promises \`mogging list\` prints "${stated.join(' ')}"; it prints "${columns.join(' ')}"`)
    }
  }
}

// ── C5 · numbers a doc states that the repo derives ───────────────────────────────────────
// An explicit allowlist, in the shape check-gate-count.mjs uses: each row names the file, the
// claim's regex, and the function that computes the truth. A regex matching zero hits is a
// blind rule, not a satisfied one.
const catalog = JSON.parse(read('src/contracts/integrations/mcp-catalog.json'))
const catalogTools = Array.isArray(catalog) ? catalog : (catalog.tools ?? [])

const DERIVED = [
  {
    what: 'MCP write tools',
    file: 'docs/14-integrations.md',
    re: /\b(?:the\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+writes?\b/gi,
    derive: () => catalogTools.filter((t) => t.access === 'write').length
  }
]

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20
}

let c5 = 0
for (const row of DERIVED) {
  const text = read(row.file)
  const hits = [...text.matchAll(row.re)]
  if (!hits.length) {
    fail(`C5 "${row.what}": the claim regex matched nothing in ${row.file} — the doc was reworded and this rule went blind; re-anchor it or drop the row`)
    continue
  }
  const truth = row.derive()
  for (const hit of hits) {
    c5++
    const spelled = hit[1].toLowerCase()
    const stated = WORDS[spelled] ?? Number(spelled)
    if (Number.isFinite(stated) && stated !== truth) {
      fail(`${row.file}: says "${hit[0].trim()}" — the repo derives ${truth} (${row.what})`)
    }
  }
}
floor('C5 derived numbers', c5, 1)

if (problems.length) {
  console.error('\nDOCS CITATIONS FAILED\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nEvery number, label and list above is DERIVED from the repo. Fix the prose.')
  process.exit(1)
}

console.log(
  `  docs citations OK — ${c1} chapter headings, ${c2} ADR labels, ${verbs.length}/${verbs.length} verbs documented, ` +
    `list columns in sync, ${c5} derived number(s)`
)
