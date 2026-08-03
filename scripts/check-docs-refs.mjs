#!/usr/bin/env node
// The docs-reference gate.
//
//   node scripts/check-docs-refs.mjs
//
// THE RULE: every relative link a doc makes is a file that exists.
//
// The docs are the product's memory: the roadmap points at ADRs, ADRs point at
// research, research points at prompt packs, and every phase points at the pack that
// shipped it. Nothing but a gate ever keeps a pointer honest. Rename `docs/09-swarm.md`
// or retire a `prompts/phase-N/` and the roadmap keeps CLAIMING the receipt exists —
// the link just quietly 404s in the reader's editor. That is the quiet kind of drift:
// the doc still reads as true.
//
// Same family as check-gates.mjs and check-protocol-version.mjs — a list that must agree
// with another list.
//
// Scope: markdown links `[text](path)` in docs/**, to RELATIVE paths (http(s):, mailto:,
// and bare #anchors are somebody else's problem). A #fragment on a real file is fine —
// we check the file, not the heading.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.md') ? [path] : []
  })

const docs = walk('docs')
if (!docs.length) {
  console.error('\nDOCS REFS: found no markdown under docs/ — the pattern is blind.\n')
  process.exit(1)
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const EXTERNAL = /^(https?:|mailto:|#)/

const broken = []
for (const doc of docs) {
  const body = readFileSync(doc, 'utf8')
  for (const [, href] of body.matchAll(LINK)) {
    if (EXTERNAL.test(href)) continue
    const target = resolve(dirname(doc), decodeURI(href.split('#')[0]))
    if (!target || existsSync(target)) continue
    broken.push({ doc, href, target: relative(process.cwd(), target) })
  }
}

if (broken.length) {
  console.error(`\nDOCS REFS: ${broken.length} link(s) point at files that do not exist.\n`)
  for (const { doc, href, target } of broken) {
    console.error(`  ${doc}\n    [..](${href})  ->  ${target}  MISSING`)
  }
  console.error('\nFix the link or restore the file. A doc that cites a receipt must have one.\n')
  process.exit(1)
}

// ── RULE 2: every backticked SOURCE PATH in a living doc is a file that exists ───────
//
// The link rule above only sees `[text](path)`. The docs cite code far more often than
// they link it — `src/main/milestone-smoke.ts`, in backticks, is how a doc names its own
// source of truth. Those rot silently and in bulk: a file moves into a subdirectory and
// every doc that named it keeps reading as true while pointing at nothing. The audit
// found this class six times over, including in docs/05, which is the file that DEFINES
// the perf budget and named a path that had not existed for months.
//
// LIVING docs only. docs/research/ is a historical record — audit reports quote code as
// it was on the day, and rewriting them to match today's tree would destroy the evidence.
// prompts/ are authoring-time specs, forward-looking by construction. Neither claims
// anything about the tree as it stands, so neither is scanned.
const SRC_TOPS = ['src', 'scripts', 'bin', 'tests', 'build', 'packaging']
const CITE = new RegExp('`((?:' + SRC_TOPS.join('|') + ')/[^`\\s]+?)(?::\\d+(?:-\\d+)?)?`', 'g')
const isLiving = (p) => !p.split(/[\\/]/).includes('research')
/** A glob, a directory, or a `<placeholder>` names a shape, not a file. */
const namesAShape = (p) => /[*{}<>]/.test(p) || p.endsWith('/')

const stale = []
let cites = 0
for (const doc of [...docs.filter(isLiving), 'README.md']) {
  let body
  try {
    body = readFileSync(doc, 'utf8')
  } catch {
    continue
  }
  for (const [, cited] of body.matchAll(CITE)) {
    cites++
    if (namesAShape(cited)) continue
    const target = cited.replace(/[.,;)]+$/, '')
    if (existsSync(target)) continue
    stale.push({ doc, target })
  }
}
if (!cites) {
  console.error('\nDOCS REFS: no backticked source paths found in the living docs — the pattern is blind.\n')
  process.exit(1)
}
if (stale.length) {
  console.error(`\nDOCS REFS: ${stale.length} source path(s) cited by a doc do not exist.\n`)
  for (const { doc, target } of stale) console.error(`  ${doc}\n    \`${target}\`  MISSING`)
  console.error('\nRepoint the citation or restore the file. A doc that names its source of truth must name a real one.\n')
  process.exit(1)
}

// ── RULE 3: an ADR number identifies exactly one ADR ────────────────────────────────
//
// Two files landed in the same release both claiming "ADR 0022" — one Accepted and cited
// by ~14 code sites, one Proposed. An ADR number is how the code refers to a decision
// (`// ADR 0022` appears throughout src/), so a duplicate makes every one of those
// references ambiguous, and nothing anywhere noticed. Numbering is exactly the kind of
// list-that-must-agree-with-itself this gate family exists for.
//
// The H1 is checked against the filename too: renaming the file without renumbering the
// heading (or the reverse) leaves the same ambiguity one layer down.
const adrs = docs
  .filter((d) => /(^|[\\/])adr[\\/]\d{4}-/.test(d))
  .map((d) => {
    const file = d.split(/[\\/]/).pop()
    const num = file.slice(0, 4)
    const h1 = (readFileSync(d, 'utf8').match(/^#\s*ADR\s*(\d{4})/m) ?? [])[1]
    return { d, num, h1 }
  })
const adrProblems = []
const byNum = new Map()
for (const a of adrs) {
  if (byNum.has(a.num)) adrProblems.push(`ADR ${a.num} is claimed by BOTH ${byNum.get(a.num)} and ${a.d}`)
  else byNum.set(a.num, a.d)
  if (a.h1 && a.h1 !== a.num) adrProblems.push(`${a.d} is filed as ${a.num} but its heading says ADR ${a.h1}`)
}
if (!adrs.length) {
  console.error('\nDOCS REFS: found no ADRs under docs/adr — the pattern is blind.\n')
  process.exit(1)
}
if (adrProblems.length) {
  console.error(`\nDOCS REFS: ${adrProblems.length} ADR numbering problem(s).\n`)
  for (const p of adrProblems) console.error(`  ${p}`)
  console.error('\nAn ADR number is how the CODE cites a decision. Two files cannot share one.\n')
  process.exit(1)
}

console.log(
  `docs refs: ${docs.length} docs, every relative link resolves; ${cites} cited source paths all exist; ` +
    `${adrs.length} ADRs uniquely numbered.`
)
