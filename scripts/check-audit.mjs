#!/usr/bin/env node
// The coverage gate (Phase-8.5/09) — an ASSERTION over AUDIT.md, not a vibe.
//
//   node scripts/check-audit.mjs [path]        # defaults to prompts/phase-8.5/AUDIT.md
//
// It parses the audit and FAILS the sweep if the pack left anything unowned:
//   1. any § Grades row whose FINAL grade is below A (e.g. still C, or stuck at A−),
//      or whose Verdict names no owner;
//   2. any § REMOVE row that is not ✅ (executed);
//   3. any § Bugs entry missing an owner or a resolution;
//   4. either § Blocker still undischarged;
//   5. any § Deviation left unresolved.
//
// Why this exists: a surface with no owner is exactly how "Settings — Usage" sat at
// D− with nobody's name on it until the 8.5/04 audit-of-the-audit found it. A check
// that cannot fail teaches you nothing, so this one reads the whole ledger and refuses
// to go green while a single row is below the bar. It is deliberately mechanical —
// it judges structure (grade tokens, ✅, owners, DISCHARGED, a resolution word), never
// prose quality — so it can run unattended in qa-smokes.sh.
import { readFileSync } from 'node:fs'

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'prompts/phase-8.5/AUDIT.md'
const md = readFileSync(file, 'utf8')
const lines = md.split('\n')

const problems = []
const fail = (rule, msg) => problems.push(`${rule}: ${msg}`)

/** The 0-based line index of the first heading whose text matches `re`, from `from`. */
const headingIdx = (re, from = 0) => {
  for (let i = from; i < lines.length; i++) if (/^#{1,3}\s/.test(lines[i]) && re.test(lines[i])) return i
  return -1
}
/** The line indices [start+1, nextHeadingOfLevel<=level) — a section body. */
const sectionBody = (startIdx) => {
  if (startIdx < 0) return []
  const level = (lines[startIdx].match(/^#+/) ?? ['#'])[0].length
  const out = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s/)
    if (h && h[1].length <= level) break
    out.push(lines[i])
  }
  return out
}
/** Split a markdown table's data rows into trimmed cell arrays (header + `---` dropped). */
const tableRows = (body) => {
  const rows = []
  for (const line of body) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue // the |---|---| separator
    rows.push(cells)
  }
  return rows
}
const stripMd = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim()

// ── 1. Grades — every FINAL grade must read A, and every verdict must name an owner ──
{
  const body = sectionBody(headingIdx(/##\s+Grades\b/))
  const rows = tableRows(body).filter((r) => r.length >= 3 && !/^Surface$/i.test(r[0]))
  if (!rows.length) fail('grades', 'no Grades table rows found — the parser or the file moved')
  for (const r of rows) {
    const surface = stripMd(r[0])
    // The final grade is whatever sits after the last arrow (C → **A** ⇒ A); no arrow ⇒ the cell.
    const gradeCell = r[1]
    const finalGrade = stripMd(gradeCell.split(/→|->/).pop())
    if (finalGrade !== 'A') fail('grades', `"${surface}" is ${finalGrade || '(blank)'} — must be A (cell: ${gradeCell.trim()})`)
    const verdict = stripMd(r[2])
    const hasOwner = /^keep$/i.test(verdict) || /\d/.test(verdict) // `keep` needs no step; anything else must cite one
    if (!hasOwner) fail('grades', `"${surface}" verdict "${verdict}" names no owner`)
  }
}

// ── 2. REMOVE — every numbered row must be ✅ (executed, not hidden) ──
{
  const body = sectionBody(headingIdx(/##\s+The REMOVE list\b/))
  const rows = tableRows(body).filter((r) => /\d/.test(r[0])) // rows keyed by a remove number
  if (!rows.length) fail('remove', 'no REMOVE table rows found')
  for (const r of rows) {
    if (!r[0].includes('✅')) fail('remove', `REMOVE #${stripMd(r[0])} is not ✅ (executed): "${stripMd(r[1] ?? '')}"`)
  }
}

// ── 3. Bugs — every entry needs an owner AND a resolution ──
{
  const body = sectionBody(headingIdx(/##\s+Bugs found\b/))
  // The routed table only: | # | Bug | Owner | Status |. The "verbatim" list below has no pipes.
  const rows = tableRows(body).filter((r) => r.length >= 4 && /^\d+$/.test(stripMd(r[0])))
  if (!rows.length) fail('bugs', 'no Bugs table rows found')
  for (const r of rows) {
    const n = stripMd(r[0])
    const owner = stripMd(r[2])
    const status = stripMd(r[3])
    if (!owner) fail('bugs', `bug #${n} has no owner`)
    if (!/✅|fixed|resolved|done/i.test(status)) fail('bugs', `bug #${n} has no resolution (status: "${status}")`)
  }
}

// ── 4. Blockers — every "Blocker N" marker must read DISCHARGED ──
{
  const body = sectionBody(headingIdx(/##\s+§\s*Blockers\b/)).join('\n')
  const found = [...body.matchAll(/\*\*Blocker\s+(\d+)\s*[—-]\s*([A-Za-z]+)/g)]
  if (found.length < 2) fail('blockers', `expected 2 Blocker dispositions, found ${found.length}`)
  for (const m of found) {
    if (!/^DISCHARGED$/i.test(m[2])) fail('blockers', `Blocker ${m[1]} is "${m[2]}", not DISCHARGED`)
  }
}

// ── 5. Deviations — every numbered deviation must carry a resolution disposition ──
{
  const body = sectionBody(headingIdx(/##\s+§\s*Deviations\b/)).join('\n')
  // Split on line-leading "N. " markers; keep chunks that begin with a number.
  const chunks = body.split(/\n(?=\d+\.\s)/).filter((c) => /^\d+\.\s/.test(c.trim()))
  if (chunks.length < 1) fail('deviations', 'no numbered deviations found')
  const RESOLVED = /✅|resolv|satisf|\baccepted\b/i
  const OPEN = /\bUNRESOLVED\b|\bTODO\b|\bFIXME\b|open question/i
  for (const c of chunks) {
    const n = c.trim().match(/^(\d+)\./)[1]
    if (OPEN.test(c)) fail('deviations', `deviation ${n} is explicitly open (UNRESOLVED/TODO/FIXME)`)
    else if (!RESOLVED.test(c)) fail('deviations', `deviation ${n} carries no resolution disposition (✅/resolved/satisfied/accepted)`)
  }
}

// ── verdict ──
if (problems.length) {
  console.error(`AUDIT coverage gate: ${problems.length} unrouted finding(s) in ${file}\n`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error(`\n::error::AUDIT.md has ${problems.length} row(s) below the bar — the pack is not frozen`)
  process.exit(1)
}
console.log(`AUDIT coverage gate: ${file} — every Grades row A, every REMOVE ✅, every bug owned + resolved, both Blockers discharged, every Deviation resolved. ✓`)
