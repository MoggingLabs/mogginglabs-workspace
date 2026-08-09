#!/usr/bin/env node
// The findings ledger gate — an ASSERTION over docs/research/findings-ledger.md.
//
//   node scripts/check-findings-ledger.mjs [path] [--update-count]
//
// Why this exists: the phase-8.5 audit sat with unowned rows until an audit-of-the-
// audit found them, and check-audit.mjs was written so that could not recur. The
// 2026-08 sweep found ~490 more defects — and nothing routed them, because
// qa-smokes.sh calls check-audit.mjs with no argument, so it only ever grades the
// 8.5 pack. A finding nobody can see age is a finding that ages.
//
// This gate is deliberately mechanical. It judges STRUCTURE, never prose:
//   1. every row carries a status from the fixed vocabulary;
//   2. every row carries a location;
//   3. a `deferred` row carries a reason of >= MIN_REASON chars — "not now" is not
//      a reason, and a deferral nobody wrote down is just an open row in disguise;
//   4. the row count matches PINNED_ROWS, so a finding cannot leave by deletion.
//      Closing work moves a row to `fixed`; it never removes it;
//   5. the Totals table at the top agrees with the tally of the rows below it;
//   6. an OPEN row cites a file that exists, at a line inside it.
//
// The count is pinned rather than derived on purpose: deriving it from the file
// would make the file its own authority, which is the failure mode this gate exists
// to prevent. Re-pin deliberately with --update-count when rows are genuinely added.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Line counts of files cited by open rows, read once each. */
const fileLines = new Map()

const STATUSES = new Set(['open', 'fixed', 'invalid', 'deferred'])
const MIN_REASON = 20
const PINNED_ROWS = 506

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'docs/research/findings-ledger.md'
const md = readFileSync(file, 'utf8')
const lines = md.split('\n')

const problems = []
const fail = (rule, msg) => problems.push(`${rule}: ${msg}`)

// The rows table is the one whose header names `id` and `status`.
const cells = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
const isSep = (cs) => cs.every((c) => /^:?-{2,}:?$/.test(c) || c === '')

let header = -1
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].trim().startsWith('|')) continue
  const cs = cells(lines[i]).map((c) => c.toLowerCase())
  if (cs[0] === 'id' && cs.includes('status')) { header = i; break }
}
if (header < 0) {
  console.error('LEDGER FAILED\n  shape: no rows table found (need a header row whose first cell is `id` and which has a `status` column)')
  process.exit(1)
}
const col = cells(lines[header]).map((c) => c.toLowerCase())
const iId = col.indexOf('id')
const iStatus = col.indexOf('status')
const iLoc = col.indexOf('location')
const iReason = col.indexOf('reason (deferred only)')

const rows = []
for (let i = header + 1; i < lines.length; i++) {
  const t = lines[i].trim()
  if (!t.startsWith('|')) { if (t === '' || t.startsWith('#')) break; continue }
  const cs = cells(lines[i])
  if (isSep(cs)) continue
  rows.push({ n: i + 1, cs })
}

const seen = new Set()
const counts = { open: 0, fixed: 0, invalid: 0, deferred: 0 }
for (const { n, cs } of rows) {
  const id = cs[iId] ?? ''
  const status = (cs[iStatus] ?? '').replace(/`/g, '').trim()
  const loc = (cs[iLoc] ?? '').replace(/`/g, '').trim()
  const reason = iReason >= 0 ? (cs[iReason] ?? '').trim() : ''

  if (!id) fail('id', `line ${n}: row has no id`)
  else if (seen.has(id)) fail('id', `line ${n}: duplicate id \`${id}\``)
  else seen.add(id)

  if (!STATUSES.has(status)) {
    fail('status', `line ${n}: \`${id}\` has status "${status}" — must be one of ${[...STATUSES].join(', ')}`)
  } else counts[status]++

  if (!loc) fail('location', `line ${n}: \`${id}\` names no location — a finding you cannot find is not tracked`)

  // 6. an OPEN row's location must still resolve. Citations rot: extracting claims.ts shrank
  //    protocol.ts by 28 lines and every citation past :162 there silently pointed at the wrong
  //    code. A reader who follows a dead citation concludes the finding is fixed.
  //
  //    Deliberately only OPEN rows, and deliberately only "does this line exist" — a closed row
  //    describes code that is meant to have changed, and proving a citation points at the RIGHT
  //    construct is a job for a person.
  if (status === 'open' && loc) {
    const m = /^([^\s:]+):(\d+)/.exec(loc.replace(/`/g, '').trim())
    if (m) {
      const [, file, lineNo] = m
      if (!existsSync(file)) {
        fail('citation', `line ${n}: \`${id}\` cites ${file}, which does not exist`)
      } else {
        if (!fileLines.has(file)) fileLines.set(file, readFileSync(file, 'utf8').split('\n').length)
        const len = fileLines.get(file)
        if (Number(lineNo) > len) {
          fail('citation', `line ${n}: \`${id}\` cites ${file}:${lineNo}, but that file has ${len} lines — the citation has rotted`)
        }
      }
    }
  }

  if (status === 'deferred' && reason.replace(/[`*_]/g, '').length < MIN_REASON) {
    fail('deferred', `line ${n}: \`${id}\` is deferred with no reason (>= ${MIN_REASON} chars) — deferring is a decision, and a decision gets written down`)
  }
}

if (args.includes('--update-count')) {
  const src = readFileSync(process.argv[1], 'utf8')
  writeFileSync(process.argv[1], src.replace(/^const PINNED_ROWS = \d+$/m, `const PINNED_ROWS = ${rows.length}`))
  console.log(`re-pinned PINNED_ROWS ${PINNED_ROWS} -> ${rows.length}`)
  process.exit(0)
}

if (rows.length !== PINNED_ROWS) {
  fail(
    'count',
    `ledger holds ${rows.length} rows, pinned at ${PINNED_ROWS}. ` +
      (rows.length < PINNED_ROWS
        ? 'Findings do not leave by deletion — close one by moving it to `fixed`.'
        : 'New findings are welcome: re-pin with `node scripts/check-findings-ledger.mjs --update-count` in the same commit that adds them.')
  )
}

// 5. the Totals table at the top of the file agrees with the rows underneath it.
//
// The file states its own totals, and nothing compared them to the tally this gate computes.
// They had drifted to `open 488 / fixed 2` while the real counts were 390 and 100 — a stale
// summary inside the very file this gate exists to keep honest, walked past by a gate that
// computed the right answer and never looked up.
//
// Derived, never typed: the expected value IS the tally.
const TOTALS = {
  rows: rows.length,
  open: counts.open,
  fixed: counts.fixed,
  invalid: counts.invalid,
  deferred: counts.deferred
}
const totalsSeen = new Map()
for (const line of md.split('\n')) {
  const m = /^\|\s*(rows|open|fixed|invalid|deferred)\s*\|\s*(\d+)\s*\|\s*$/.exec(line)
  if (m) totalsSeen.set(m[1], Number(m[2]))
}
if (totalsSeen.size === 0) {
  // Blindness guard: a reworded table must fail loudly, not silently stop being checked.
  problems.push('the Totals table is gone or reshaped — the summary can no longer be checked against the rows')
} else {
  for (const [key, expected] of Object.entries(TOTALS)) {
    if (!totalsSeen.has(key)) problems.push(`Totals table has no \`${key}\` row (the rows say ${expected})`)
    else if (totalsSeen.get(key) !== expected) {
      problems.push(`Totals says ${key} = ${totalsSeen.get(key)}, the rows say ${expected} — the summary is derived, never typed`)
    }
  }
}

if (problems.length) {
  console.error('LEDGER FAILED')
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}

const open = counts.open
console.log(
  `ledger OK — ${rows.length} findings: ${open} open, ${counts.fixed} fixed, ` +
    `${counts.invalid} invalid, ${counts.deferred} deferred (${file})`
)
