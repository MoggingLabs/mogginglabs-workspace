#!/usr/bin/env node
// The LAUNCHAUDIT coverage gate (phase-launch/01) — an ASSERTION over INVENTORY.md +
// FINDINGS.md, not a vibe.
//
//   node scripts/check-launch-audit.mjs                     # the sweep's mode
//   node scripts/check-launch-audit.mjs --freeze            # additionally: no lens may still be pending
//   node scripts/check-launch-audit.mjs --inventory P --findings Q   # for bite-proofs against scratch copies
//
// WHY THIS EXISTS. Part I of the launch pack claims "we checked everything." That claim is
// worth exactly nothing unless something can falsify it. Phase-8.5 learned this the expensive
// way: "Settings — Usage" sat at D- with nobody's name on it until the audit-OF-the-audit
// found it (see scripts/check-audit.mjs, this gate's older sibling). An audit with no
// denominator cannot be incomplete, because nobody wrote down what complete would mean.
//
// So this gate holds three lines, and each one is mechanical:
//
//   1. THE DENOMINATOR IS CLOSED. Every gate in scripts/qa-smokes.sh is claimed by at least
//      one INVENTORY row. That is the "no subsystem without a row" proof — inverted, because
//      the honest direction is the one you cannot satisfy by writing more rows. Land a gate
//      for a new subsystem and forget its row, and this reds.
//   2. THE ROWS ARE REAL. Every entry point resolves (file exists, line in range, the named
//      symbol still greps) and every cited doc exists. A row pointing at a deleted file is
//      an audit of nothing.
//   3. THE GRADE IS DERIVED. Nobody types a letter. Each (row, lens) is A if and only if
//      FINDINGS.md carries no unresolved finding against it. The lens cell records WHO swept
//      it (a step id), never how it went — provenance, not self-assessment.
//
// And the ledger itself is constrained: `fixed` and `invalid` are the ONLY verdicts. There is
// no `defer` and no `wontfix`, because those are how a known defect ships. Severity ORDERS the
// queue; it never decides whether to fix. `invalid` means DISPROVEN — the claimed behavior did
// not reproduce — never merely argued away.
//
// Pure file parse: zero boot, zero network, ~40ms. Same law as check-audit.mjs.
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const FREEZE = argv.includes('--freeze')
const INVENTORY = resolve(ROOT, flag('inventory', 'prompts/phase-launch/INVENTORY.md'))
const FINDINGS = resolve(ROOT, flag('findings', 'prompts/phase-launch/FINDINGS.md'))
const SWEEP = join(ROOT, 'scripts', 'qa-smokes.sh')

// The six lenses of RUBRIC.md, in the column order INVENTORY.md declares them.
const LENSES = ['corr', 'smell', 'spag', 'dup', 'eff', 'debt']
// A lens cell names the STEP that swept it. `~NN` = pending, owned by step NN (the pack's own
// `[~]` convention from CHECKLIST.md). Bare `NN` = swept. Part I's audit steps are 02..07.
const LENS_CELL = /^(~?)(0[2-7])$/
// The verdicts that exist. Anything else is a way of shipping a known defect.
const VERDICTS = new Set(['fixed', 'invalid'])
const DELETED_VERDICTS = new Set(['open', 'defer', 'wontfix', 'deferred', 'accepted', 'known'])

const problems = []
const fail = (rule, msg) => problems.push(`${rule}: ${msg}`)

const stripMd = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim()

/** Split a markdown table's data rows into trimmed cell arrays (header + `---` dropped). */
const tableRows = (lines) => {
  const rows = []
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue // the |---|---| separator
    rows.push(cells)
  }
  return rows
}

/** Cheap line count without holding the whole file twice. */
const lineCount = (abs) => readFileSync(abs, 'utf8').split('\n').length

/**
 * Blank out `<!-- … -->` blocks, preserving line numbering.
 *
 * Both ledgers document themselves with a commented-out ROW TEMPLATE, and a parser that
 * cannot tell a template from an entry reads the example as data — which is how this gate
 * first reported "1 finding, all resolved" against an empty ledger. A seed that scores
 * itself off its own instructions is worse than no gate.
 */
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))

for (const f of [INVENTORY, FINDINGS, SWEEP]) {
  if (!existsSync(f)) {
    console.error(`\nLAUNCHAUDIT: ${f} does not exist — the gate has nothing to read.\n`)
    process.exit(1)
  }
}

// ── the registry: every gate the sweep actually runs ────────────────────────────────────
const sweep = readFileSync(SWEEP, 'utf8')
const SWEEP_GATES = new Set([
  ...[...sweep.matchAll(/^run_smoke\s+(\S+)\s+MOGGING_\w+/gm)].map((m) => m[1]),
  ...[...sweep.matchAll(/^run_static\s+(\S+)/gm)].map((m) => m[1]),
])
if (SWEEP_GATES.size < 50) {
  console.error(`\nLAUNCHAUDIT: only ${SWEEP_GATES.size} gates parsed from ${SWEEP} — the pattern went blind.\n`)
  process.exit(1)
}

// ── INVENTORY: parse the rows ───────────────────────────────────────────────────────────
const invLines = stripComments(readFileSync(INVENTORY, 'utf8')).split('\n')
const rows = []
{
  // Rows live in tables under `### <area> — <phase>` headings, inside the `## The rows`
  // section. The heading supplies the area, so the table stays narrow enough to read; the
  // section scope keeps the doc's own explainer tables from being read as inventory.
  let area = null
  let sawTable = false
  let inRows = false
  for (const line of invLines) {
    const h2 = line.match(/^##\s+(?!#)(.+?)\s*$/)
    if (h2) {
      inRows = /^The rows\b/i.test(stripMd(h2[1]))
      area = null
      continue
    }
    if (!inRows) continue
    const h = line.match(/^###\s+(.+?)\s*$/)
    if (h) {
      area = stripMd(h[1]).split(/—|–/)[0].trim()
      continue
    }
    if (!line.trim().startsWith('|') || !area) continue
    const cells = tableRows([line])[0]
    if (!cells) continue
    if (/^#$/.test(cells[0]) || /^id$/i.test(cells[0])) {
      sawTable = true
      continue
    } // header
    // A row whose id cell is not a plain number is REJECTED, never skipped. Skipping is
    // silent deletion: mangle `| 88 |` and the row leaves the census entirely — its six
    // lens cells stop being counted and `--freeze` would call the pack done without ever
    // having swept it. The closed-denominator rule only catches it when the row uniquely
    // claims a gate, so it is not a backstop. Inside `## The rows` the only non-row pipe
    // lines are the `| # |` header (above) and the `|---|` separator (dropped by tableRows).
    if (!/^\d+$/.test(stripMd(cells[0]))) {
      fail('inventory', `${area}: row id "${stripMd(cells[0])}" is not a number — a malformed row cannot be silently dropped`)
      continue
    }
    rows.push({ area, cells, line })
  }
  if (!sawTable) fail('inventory', 'no table header found — the parser or the file moved')
  if (!rows.length) fail('inventory', 'no INVENTORY rows found — the parser or the file moved')
}

const EXPECTED_COLS = 5 + LENSES.length // # | feature | entry | spec | gates | + six lenses
const seenIds = new Map()
const claimedGates = new Set()
const rowById = new Map()

for (const row of rows) {
  const { area, cells } = row
  const id = stripMd(cells[0])
  const where = `row #${id} (${area})`

  if (cells.length !== EXPECTED_COLS) {
    fail('inventory', `${where} has ${cells.length} cells, expected ${EXPECTED_COLS}`)
    continue
  }
  if (seenIds.has(id)) fail('inventory', `row id #${id} is used twice (also ${seenIds.get(id)})`)
  seenIds.set(id, area)

  const feature = stripMd(cells[1])
  if (!feature) fail('inventory', `${where} names no feature`)

  // ── the entry point must resolve: `path/to/file.ts:123 symbolName` ──
  const entry = stripMd(cells[2])
  const m = entry.match(/^([^\s:]+):(\d+)(?:\s+(\S+))?$/)
  if (!m) {
    fail('entry', `${where} entry "${entry}" is not \`path:line [symbol]\``)
  } else {
    const [, relPath, lineNo, symbol] = m
    const abs = join(ROOT, relPath.split('/').join(sep))
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      fail('entry', `${where} points at ${relPath}, which does not exist`)
    } else {
      const total = lineCount(abs)
      if (Number(lineNo) < 1 || Number(lineNo) > total) {
        fail('entry', `${where} cites ${relPath}:${lineNo}, but the file has ${total} lines`)
      }
      // The LINE is a signpost and drifts with every edit above it; the SYMBOL is the anchor,
      // and a symbol that no longer greps is real rot — the feature moved or died.
      if (symbol) {
        const body = readFileSync(abs, 'utf8')
        const rx = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        if (!rx.test(body)) fail('entry', `${where} anchors on \`${symbol}\`, which no longer appears in ${relPath}`)
      }
    }
  }

  // ── the spec doc must exist ──
  const spec = stripMd(cells[3])
  if (!spec) fail('spec', `${where} cites no spec doc`)
  else {
    for (const one of spec.split(/[,·]/).map((s) => s.trim()).filter(Boolean)) {
      const abs = join(ROOT, one.split('/').join(sep))
      if (!existsSync(abs)) fail('spec', `${where} cites ${one}, which does not exist`)
    }
  }

  // ── the gates must be real gates ──
  const gates = stripMd(cells[4])
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter(Boolean)
  if (!gates.length) fail('gates', `${where} names no covering gate (use \`none\` and say why in the doc if truly uncovered)`)
  for (const g of gates) {
    if (g === 'none') continue
    if (!SWEEP_GATES.has(g)) fail('gates', `${where} claims gate ${g}, which is not in ${'scripts/qa-smokes.sh'}`)
    else claimedGates.add(g)
  }

  // ── the lens cells: provenance tokens, never letters ──
  const lenses = {}
  cells.slice(5).forEach((cell, i) => {
    const lens = LENSES[i]
    const tok = stripMd(cell)
    const lm = tok.match(LENS_CELL)
    if (!lm) {
      fail('lens', `${where} lens "${lens}" is ungraded (cell: "${tok || '(blank)'}") — expected a step id like 02, or ~02 while pending`)
      return
    }
    lenses[lens] = { pending: lm[1] === '~', step: lm[2] }
    if (FREEZE && lm[1] === '~') fail('freeze', `${where} lens "${lens}" is still pending (~${lm[2]}) — the pack cannot freeze with an unswept lens`)
  })

  rowById.set(id, { id, area, feature, lenses })
}

// ── the denominator: every gate in the sweep is claimed by some row ──────────────────────
{
  const unclaimed = [...SWEEP_GATES].filter((g) => !claimedGates.has(g)).sort()
  for (const g of unclaimed) {
    fail('coverage', `gate ${g} is covered by no INVENTORY row — a subsystem with no row cannot be audited`)
  }
}

// ── FINDINGS: the ledger ────────────────────────────────────────────────────────────────
const findLines = stripComments(readFileSync(FINDINGS, 'utf8')).split('\n')
const findings = []
{
  let sawHeader = false
  // Scoped to `## Ledger` for the same reason the inventory scan is scoped to `## The rows`:
  // this doc explains itself in tables too. `## The columns` opens with `| **id** | …`, whose
  // first cell strips to exactly `id` — so an UNSCOPED scan satisfied `sawHeader` off the
  // LEGEND, 35 lines above the real header, and the anti-blindness guard below was decorative:
  // delete the whole ledger (a merge that keeps the prose, a truncation) and the gate printed
  // `0 finding(s), all resolved · every lens derives A ✓` and exited 0. That is the failure
  // this file's own history records (see stripComments) arriving through a second door.
  let inLedger = false
  for (const line of findLines) {
    const h2 = line.match(/^##\s+(?!#)(.+?)\s*$/)
    if (h2) {
      inLedger = /^Ledger\b/i.test(stripMd(h2[1]))
      continue
    }
    if (!inLedger) continue
    if (!line.trim().startsWith('|')) continue
    const cells = tableRows([line])[0]
    if (!cells) continue
    if (/^id$/i.test(stripMd(cells[0]))) {
      sawHeader = true
      continue
    }
    // Rejected, not skipped — same law as the inventory ids. A mangled `F013` would otherwise
    // drop the row before the verdict/evidence checks ever see it, and an UNRESOLVED finding
    // would vanish from the ledger while its (row, lens) quietly derives A.
    if (!/^F\d+$/i.test(stripMd(cells[0]))) {
      fail('findings', `ledger row "${stripMd(cells[0])}" is not a finding id (expected e.g. \`F001\`) — a malformed row cannot be silently dropped`)
      continue
    }
    findings.push(cells)
  }
  // Zero findings is a legitimate state (the seed). A missing TABLE is not — that is the
  // parser going blind, which reads as "clean" and is the one failure mode this must not have.
  if (!sawHeader) fail('findings', 'no FINDINGS table header found — the parser or the file moved')
}

const EXPECTED_F_COLS = 8 // id | area | lens | file:line | sev | verdict | evidence | resolved-in
const seenFindingIds = new Set()
/** (rowId, lens) -> count of findings that are NOT resolved. */
const unresolved = new Map()

for (const cells of findings) {
  const id = stripMd(cells[0])
  if (cells.length !== EXPECTED_F_COLS) {
    fail('findings', `${id} has ${cells.length} cells, expected ${EXPECTED_F_COLS}`)
    continue
  }
  if (seenFindingIds.has(id)) fail('findings', `finding id ${id} is used twice`)
  seenFindingIds.add(id)

  // `area` IS the inventory row the finding lands on. A finding with no row has no
  // denominator — it cannot move a grade, so it cannot be tracked to A.
  const areaCell = stripMd(cells[1])
  const rowRef = areaCell.match(/#(\d+)/)
  if (!rowRef) fail('findings', `${id} area "${areaCell}" names no INVENTORY row (expected e.g. \`#42\`)`)
  else if (!rowById.has(rowRef[1])) fail('findings', `${id} lands on row #${rowRef[1]}, which does not exist in INVENTORY.md`)

  const lens = stripMd(cells[2])
  if (!LENSES.includes(lens)) fail('findings', `${id} lens "${lens}" is not one of ${LENSES.join('/')}`)

  const site = stripMd(cells[3])
  const sm = site.match(/^([^\s:]+):(\d+)/)
  if (!sm) fail('findings', `${id} site "${site}" is not \`path:line\``)
  else if (!existsSync(join(ROOT, sm[1].split('/').join(sep)))) fail('findings', `${id} cites ${sm[1]}, which does not exist`)

  const sev = stripMd(cells[4])
  if (!/^S[123]$/.test(sev)) fail('findings', `${id} severity "${sev}" is not S1/S2/S3`)

  const verdict = stripMd(cells[5]).toLowerCase()
  const evidence = stripMd(cells[6])
  const resolvedIn = stripMd(cells[7])

  if (DELETED_VERDICTS.has(verdict)) {
    fail(
      'verdict',
      `${id} carries verdict "${verdict}" — that verdict does not exist in this pack. Every finding is must-fix: ` +
        `\`fixed\` (with a regression assertion red on pre-fix bytes) or \`invalid\` (DISPROVEN). Severity orders the queue; it never excuses one.`
    )
  } else if (!VERDICTS.has(verdict)) {
    fail('verdict', `${id} verdict "${verdict}" is not \`fixed\` or \`invalid\``)
  }

  if (!evidence) fail('findings', `${id} carries no evidence`)
  if (verdict === 'fixed' && !resolvedIn) fail('findings', `${id} is \`fixed\` but names no resolved-in (the step/commit that landed it)`)
  if (verdict === 'fixed' && !/red|assert|bite|regress|smoke|unit|gate/i.test(evidence)) {
    fail('findings', `${id} is \`fixed\` but its evidence names no assertion that went red on the pre-fix bytes`)
  }
  if (verdict === 'invalid' && !/DISPROVEN/.test(stripMd(cells[6]))) {
    fail('findings', `${id} is \`invalid\` but its evidence does not say DISPROVEN — an invalid finding is one that did not REPRODUCE, never one that was argued away`)
  }

  // A finding drags its (row, lens) below A until it is resolved.
  if (!VERDICTS.has(verdict) && rowRef && LENSES.includes(lens)) {
    const key = `${rowRef[1]}|${lens}`
    unresolved.set(key, (unresolved.get(key) ?? 0) + 1)
  }
}

// ── the derivation: A ≡ zero unresolved findings on that lens for that row ───────────────
const grades = []
for (const [id, row] of rowById) {
  for (const lens of LENSES) {
    const n = unresolved.get(`${id}|${lens}`) ?? 0
    const state = row.lenses[lens]
    const grade = n === 0 ? 'A' : 'below-A'
    grades.push({ row: id, area: row.area, lens, grade, unresolved: n, pending: state?.pending ?? null, step: state?.step ?? null })
    if (n > 0) {
      fail('grade', `row #${id} (${row.area}) lens "${lens}" derives ${grade} — ${n} unresolved finding(s). The floor is A.`)
    }
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────
const pendingCount = grades.filter((g) => g.pending).length
const sweptCount = grades.filter((g) => g.pending === false).length
const pass = problems.length === 0

mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(
  join(ROOT, 'out', 'launchaudit-result.json'),
  JSON.stringify(
    {
      pass,
      mode: FREEZE ? 'freeze' : 'sweep',
      rows: rowById.size,
      lensCells: grades.length,
      swept: sweptCount,
      pending: pendingCount,
      findings: findings.length,
      gatesInSweep: SWEEP_GATES.size,
      gatesClaimed: claimedGates.size,
      problems,
    },
    null,
    2
  ) + '\n'
)

if (!pass) {
  console.error(`LAUNCHAUDIT: ${problems.length} problem(s) across ${INVENTORY} + ${FINDINGS}\n`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error(`\n::error::the launch audit is not provably complete — ${problems.length} row(s)/finding(s) below the bar`)
  process.exit(1)
}

const pendingNote = pendingCount
  ? `${pendingCount} lens cell(s) still PENDING (owned by steps 02–07) — \`--freeze\` refuses these`
  : 'every lens swept'
console.log(
  `LAUNCHAUDIT: ${rowById.size} rows · ${grades.length} lens cells (${sweptCount} swept, ${pendingCount} pending) · ` +
    `${findings.length} finding(s), all resolved · ${claimedGates.size}/${SWEEP_GATES.size} sweep gates claimed · every lens derives A. ✓`
)
console.log(`  ${pendingNote}`)
