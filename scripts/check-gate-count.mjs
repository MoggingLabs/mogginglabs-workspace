#!/usr/bin/env node
// The gate-count gate.
//
//   node scripts/check-gate-count.mjs
//
// THE RULE: a doc that says how big the sweep is says the size it ACTUALLY is, and a
// release command in docs/10 names the version we ACTUALLY ship.
//
// The registry is `scripts/qa-smokes.sh` and nothing else. Every number below is DERIVED
// from it at runtime — `run_smoke` rows (the app-boot gates) plus `run_static` rows (the
// script gates). Nothing here is written down twice, because writing it down twice is the
// whole disease: the count moves every time a gate lands, the prose does not, and the prose
// still READS as true. That is the quiet kind of drift — the same family as check-gates.mjs
// and check-docs-refs.mjs, a list that must agree with another list, and nothing but a gate
// ever makes lists agree.
//
// It rotted exactly that way. Before this gate, one repo said all of: 24 gates, 35 gates
// (three times), 83 gates, 87 gates — and `ci.yml` contradicted ITSELF, claiming 87 on line 7
// and 35 on three others. Every one of those was true on the day it was typed.
//
// SCOPE — present tense only. `docs/02-mvp-and-roadmap.md`'s "the sweep grew 35→52→66→83"
// lines are DATED changelog entries: they record what was true when a phase shipped, and they
// are still true as history. Same for `prompts/phase-11/README.md`'s "as of authoring" note
// and REPORT.md's errata. A gate that "fixed" those would be falsifying the record. So this
// gate does not scan by number — it scans an explicit ALLOWLIST of (file, regex) pairs, each
// anchored on a sentence that asserts the CURRENT size. If you add a doc that states the
// count, add it here; if a regex ever stops matching, this gate fails loudly rather than
// passing blind.
import { readFileSync } from 'node:fs'

const SWEEP = 'scripts/qa-smokes.sh'
const DIST = 'docs/10-distribution.md'

const sweep = readFileSync(SWEEP, 'utf8')

// Derived, never declared. The run_smoke shape is check-gates.mjs's, verbatim.
const RUNTIME = [...sweep.matchAll(/^run_smoke\s+(\S+)\s+(MOGGING_\w+)/gm)].length
const STATIC = [...sweep.matchAll(/^run_static\s+(\S+)/gm)].length
const TOTAL = RUNTIME + STATIC

if (!RUNTIME || !STATIC) {
  console.error(`\nGATE COUNT: found no run_smoke/run_static rows in ${SWEEP} — the pattern is blind.\n`)
  process.exit(1)
}

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version

// Every place that asserts the CURRENT sweep size. `re` must capture the asserted number in
// group 1, and must match at least once — a pattern that matches nothing is a rotted pattern,
// not a pass.
const CLAIMS = [
  // The sweep's own header: the first thing anyone reads before running it.
  { file: SWEEP, re: /^#\s*(\d+) gates:/gm, expect: TOTAL, what: 'sweep total' },
  { file: SWEEP, re: /^#\s*\d+ gates:\s*(\d+) static/gm, expect: STATIC, what: 'static gates' },
  { file: SWEEP, re: /\+\s*(\d+) app-boot/gm, expect: RUNTIME, what: 'app-boot gates' },

  // Four comments in one file, which used to disagree with each other.
  { file: '.github/workflows/ci.yml', re: /(\d+)-gate sweeps?\b/g, expect: TOTAL, what: 'sweep total' },

  { file: 'README.md', re: /sweep now runs \*\*(\d+) gates\*\*/g, expect: TOTAL, what: 'sweep total' },

  { file: DIST, re: /\*\*Swept \((\d+) gates\)\*\*/g, expect: TOTAL, what: 'sweep total' },

  // `\s+` spans the line wrap: the phrase breaks across lines in prose.
  { file: 'docs/12-usage.md', re: /(\d+)-gate\s+sweep/g, expect: TOTAL, what: 'sweep total' },

  // Phase-11's operator TODO — present tense ("run this"), unlike the pack's dated
  // "sweep 76 → 83 as of authoring" note and its §6 errata, which are history.
  { file: 'prompts/phase-11/README.md', re: /\([^()]*?(\d+) gates\)/g, expect: TOTAL, what: 'sweep total' },
  { file: 'prompts/phase-11/REPORT.md', re: /all (\d+) gates/g, expect: TOTAL, what: 'sweep total' },
  { file: 'prompts/phase-11/REPORT.md', re: /local sweep \((\d+) gates,/g, expect: TOTAL, what: 'sweep total' },

  // The Brain book's present-tense claim (Phase 12): total + both components.
  { file: 'docs/20-brain.md', re: /stands at \*\*(\d+) gates/g, expect: TOTAL, what: 'sweep total' },
  { file: 'docs/20-brain.md', re: /gates \((\d+) app-boot/g, expect: RUNTIME, what: 'app-boot gates' },
  { file: 'docs/20-brain.md', re: /app-boot \+ (\d+) static\)/g, expect: STATIC, what: 'static gates' },
]

// A version token in docs/10 that is deliberately HISTORICAL: a closed interval naming
// releases a since-fixed bug spanned, not a command anyone will copy-paste. Keyed on the
// surrounding words, not a line number, so it survives edits above it. Adding an entry means
// arguing the token names a PAST release ON PURPOSE.
const HISTORICAL = [
  { contains: 'broke every update from', why: 'the artifactName bug and the releases it spanned' },
  // The committed winget/homebrew manifests pin the LAST SHIPPED release's bytes by
  // design (they regenerate from the new release's artifacts AFTER it publishes) —
  // the version they name is a past release on purpose until that post-release step.
  { contains: 'committed manifests pin the shipped', why: 'manifests regenerate post-release; they truthfully name the last shipped artifacts' }
]

const lineOf = (text, index) => text.slice(0, index).split('\n').length
const lineAt = (text, index) => text.split('\n')[lineOf(text, index) - 1]

const bad = []
const blind = []

for (const { file, re, expect, what } of CLAIMS) {
  const body = file === SWEEP ? sweep : readFileSync(file, 'utf8')
  let hits = 0
  for (const m of body.matchAll(re)) {
    hits += 1
    const claimed = Number(m[1])
    if (claimed === expect) continue
    bad.push({ file, line: lineOf(body, m.index), claimed, actual: expect, what })
  }
  if (!hits) blind.push({ file, re, what })
}

// Version freshness: docs/10 is where release commands get copy-pasted, and a stale `v0.4.0`
// in `gh release download` downloads the wrong release without saying so.
const dist = readFileSync(DIST, 'utf8')
for (const m of dist.matchAll(/v(\d+\.\d+\.\d+)/g)) {
  if (m[1] === VERSION) continue
  const text = lineAt(dist, m.index)
  if (HISTORICAL.some((h) => text.includes(h.contains))) continue
  bad.push({ file: DIST, line: lineOf(dist, m.index), claimed: `v${m[1]}`, actual: `v${VERSION}`, what: 'version' })
}

if (blind.length) {
  console.error('\nGATE COUNT: a pattern matched nothing — the doc was reworded and this gate went blind.\n')
  for (const { file, re, what } of blind) console.error(`  ${file}\n    ${re}  (${what})  NO MATCH`)
  console.error('\nRe-anchor the regex in scripts/check-gate-count.mjs, or drop the claim from the doc.\n')
  process.exit(1)
}

if (bad.length) {
  console.error(`\nGATE COUNT DRIFT — ${bad.length} claim(s) the registry contradicts.\n`)
  for (const { file, line, claimed, actual, what } of bad) {
    console.error(`  ${file}:${line}: claims ${claimed}, actual ${actual}   (${what})`)
  }
  console.error(`\nThe registry is ${SWEEP}: ${RUNTIME} run_smoke + ${STATIC} run_static = ${TOTAL}.`)
  console.error(`package.json ships v${VERSION}. Fix the prose — the count is derived, never typed.\n`)
  process.exit(1)
}

console.log(
  `  gate count OK — ${TOTAL} gates (${RUNTIME} app-boot + ${STATIC} static), v${VERSION}; ${CLAIMS.length} claims agree`
)
