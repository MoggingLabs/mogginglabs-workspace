#!/usr/bin/env node
// The smoke-verdict gate — a gate over the GATES.
//
//   node scripts/check-smoke-verdict.mjs
//
// THE RULE: a budget clause may not be satisfied by the absence of a measurement.
//
// Every smoke hand-writes its own `pass` / `budgetOk` expression, and the same shortcut
// kept appearing in them:
//
//     (heapMB     === -1 || heapMB     <= B.maxHeapMB)
//     (echoMedian === -1 || echoMedian <= B.echoMs)
//     (homeMax    === -1 || homeMax    <= B.actionMs)
//
// `-1` is the sentinel for "we measured nothing", and it SATISFIES the clause. So a dead
// keystroke round-trip, a renderer with no performance.memory, and a Board button whose
// selector drifted each produced a green gate over a budget nobody checked — and echo is
// the one budget docs/07 says is never relaxed.
//
// The shape is unmistakable because the SAME identifier appears on both sides: a sentinel
// test OR'd into a comparison of the very same value. A real bounds check (`cx < 0 ||
// cy > innerWidth`) names different identifiers and is left alone.
//
// The fix these sites take is always the same: give presence its own named invariant, so
// "not measured" reads as "not measured" instead of hiding inside someone else's clause.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join('src', 'main', 'smokes')

/** A verdict expression: `const pass|budgetOk|ok =` up to a blank line or a `return`. */
const VERDICT = /const\s+(pass|budgetOk|ok)\s*=\s*([\s\S]{0,2000}?)(?:\n\s*\n|\n\s*return\b)/g
/** Same identifier on both sides: an absence sentinel OR'd into that value's own budget. */
const SENTINEL = /\b([A-Za-z_$][\w$.]*)\s*(?:===\s*-1|===\s*0|<\s*0)\s*\|\|\s*\1\s*(?:<=|<|>=|>)/

/** file:line + the exact text, so the failure names the clause rather than the file. */
function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'))
const problems = []
let verdicts = 0

for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8')
  VERDICT.lastIndex = 0
  let m
  while ((m = VERDICT.exec(src))) {
    verdicts++
    const hit = SENTINEL.exec(m[2])
    if (!hit) continue
    const at = lineOf(src, m.index + m[0].indexOf(hit[0]))
    problems.push(`${DIR.split(/[\\/]/).join('/')}/${f}:${at}  ${m[1]} — ${hit[0].trim()}`)
  }
}

// Blindness refusal, the same one check-gate-count and check-credential-wording carry: a
// pattern that matched nothing is a ROTTED pattern, not a clean bill of health. These
// expressions are found by regex over source, so a reformat can silently take the gate out.
if (files.length < 50 || verdicts < 50) {
  console.error(
    `\nSMOKE VERDICT: inspected ${files.length} smoke(s) and found ${verdicts} verdict expression(s) — the pattern is blind.\n` +
      'Either the smokes moved, or a reformat broke the lift. A gate that reads nothing must not pass.\n'
  )
  process.exit(1)
}

if (problems.length) {
  console.error(`\nSMOKE VERDICT: ${problems.length} budget clause(s) that an ABSENT measurement satisfies.\n`)
  for (const p of problems) console.error(`  ${p}`)
  console.error(
    '\n`x === -1 || x <= budget` is not a budget check — -1 is the sentinel for "we measured\n' +
      'nothing", and it passes. Give presence its own named invariant (heapMeasured,\n' +
      'echoMeasured) and require it, so an unmeasured run reads as unmeasured.\n'
  )
  process.exit(1)
}

console.log(`  smoke verdict OK — ${verdicts} verdict expression(s) across ${files.length} smokes, no absence-satisfies-budget clause`)
