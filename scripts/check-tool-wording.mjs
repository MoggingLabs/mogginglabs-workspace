#!/usr/bin/env node
// TOOLWORDS — the plumbing-jargon gate (ADR 0020, phase-tools/01).
//
//   node scripts/check-tool-wording.mjs             # report-only until steps 05–06 flip it
//   node scripts/check-tool-wording.mjs --enforce   # exit 1 on any violation (the future default)
//
// THE RULE: the integrations surfaces speak OUTCOMES, not mechanism. "Servers on
// your CLIs" is a sentence that means nothing until the user has read three
// paragraphs — and it was typed by us, in the house voice, which is exactly why a
// list (not a style note) has to hold the line. Banned at top level: MCP, server,
// stdio, transport, drift, apply, adopt, preset, Route A/B. Mechanism words remain
// legal in fine print (the custody subtitles) and in the Library's advanced fold —
// via the ALLOWED list below, which pins each survivor to the exact line it was
// reviewed with (the check-credential-wording.mjs discipline).
//
// REPORT-ONLY FOR NOW (the LAUNCHAUDIT pattern): today's copy predates the tool-
// first rebuild and is FULL of these words — this gate exists from step 01 so the
// violation count only ever goes DOWN, and flips to enforcing as steps 05–06 land
// the new surfaces. The count printed at the bottom is the burn-down.
//
// Scope: string literals in src/ui/features/settings/**/*.ts — the strings a user
// actually reads. Comments and identifiers are out of scope by construction (we
// tokenize literals out of comment-stripped source). Sentence-ish literals only
// (must contain a space): a bare class name like 'mgr-server-id' is CSS, not copy.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SCOPE = join(ROOT, 'src', 'ui', 'features', 'settings')
const ENFORCE = process.argv.includes('--enforce') || process.env.MOGGING_TOOLWORDS_ENFORCE === '1'

const BANNED = [
  ['mcp', /\bMCPs?\b/],
  ['server', /\bservers?\b/i],
  ['stdio', /\bstdio\b/i],
  ['transport', /\btransports?\b/i],
  ['drift', /\bdrift(?:ed|s)?\b/i],
  ['apply', /\b(?:re-)?appl(?:y|ied|ies)\b/i],
  ['adopt', /\badopt(?:ed|s)?\b/i],
  ['preset', /\bpresets?\b/i],
  ['route-ab', /\bRoute\s+[AB]\b/]
]

// Exact substrings that stay legal, pinned per file. Fine-print custody lines and
// the Library's advanced fold earn entries here as steps 05–06 land; an entry is
// suppressed only while the line still contains the reviewed text verbatim.
const ALLOWED = [
  // ── The intended survivors (ADR 0020: mechanism words stay legal in fine print
  //    and in the Library's advanced fold). Each pin names its reviewed line; an
  //    entry suppresses only while the text survives verbatim. (phase-tools/07)
  // Route-badge tooltips + token-auth toast: custody fine print on the audit card.
  { file: 'src/ui/features/settings/integrations.ts', contains: 'uses token auth' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'This server rides an app-held connection' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'Each CLI holds its own credential for this server' },
  // The audit row's id line + transport tooltips: the power-user detail, by design.
  { file: 'src/ui/features/settings/integrations.ts', contains: '${transportLabel(server)}' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'Streamable-HTTP MCP transport' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'stdio transport — a local subprocess' },
  // The add-your-own form (advanced; SECRETFORMS anchors its hooks): precise words
  // are the point when a user hand-writes a config entry.
  { file: 'src/ui/features/settings/integrations.ts', contains: 'Add server…' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'Server id' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'command (stdio)' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'http transport' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'stdio transport.' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'Save server' },
  // The audit card's caption + the vault card's honesty lines: custody fine print.
  { file: 'src/ui/features/settings/integrations.ts', contains: 'Every server your CLIs know about' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'reference it as ${NAME} in a server’s env' },
  { file: 'src/ui/features/settings/integrations.ts', contains: 'any key an MCP server needs is readable' },
  // The Library's ADVANCED fold (registry search, import/export, per-CLI route):
  // the one place plumbing vocabulary is the honest vocabulary.
  { file: 'src/ui/features/settings/library.ts', contains: 'Key slots (env references, never literals)' },
  { file: 'src/ui/features/settings/library.ts', contains: 'adding here makes the server available to a CLI' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Search the official MCP registry' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Save as server' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Paste a preset JSON to import' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Import preset JSON' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Imported as a community preset.' },
  { file: 'src/ui/features/settings/library.ts', contains: 'writes the server into each CLI’s own config' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Write a server into a CLI’s own config' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Export preset' },
  { file: 'src/ui/features/settings/library.ts', contains: 'Connect ${preset.label}' },
  { file: 'src/ui/features/settings/library.ts', contains: 'verified ${preset.verifiedAt}' }
]

// ── ENFORCED files (phase-tools/05, deliverable 9) ────────────────────────────
// Every file the tool-card step REWROTE holds the line from now on: a violation
// here fails the gate even in report-only mode. The rest of the scope stays on
// the burn-down until step 06 rewrites it (the reconciler) and joins this list.
const ENFORCED_FILES = new Set([
  'src/ui/features/settings/connections.ts'
])

// The reconciler VOCABULARY (phase-tools/06): drift/apply/adopt left the
// integrations surfaces for good — those categories enforce across every
// integrations file even where the file as a whole is still on the burn-down.
const ENFORCED_CATEGORIES = new Set(['drift', 'apply', 'adopt'])
const ENFORCED_CATEGORY_FILES = new Set([
  'src/ui/features/settings/connections.ts',
  'src/ui/features/settings/integrations.ts',
  'src/ui/features/settings/library.ts'
])

function tsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Strip comments, then yield [literal, line] for every string literal. */
function literals(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
  const out = []
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  let m
  while ((m = re.exec(noComments))) {
    const text = m[1] ?? m[2] ?? m[3] ?? ''
    const line = noComments.slice(0, m.index).split('\n').length
    out.push([text, line])
  }
  return out
}

const violations = []
for (const file of tsFiles(SCOPE)) {
  const rel = relative(ROOT, file).split(sep).join('/')
  const src = readFileSync(file, 'utf8')
  for (const [text, line] of literals(src)) {
    if (!text.includes(' ')) continue // class lists and ids are not copy
    for (const [name, re] of BANNED) {
      if (!re.test(text)) continue
      const allowed = ALLOWED.some((a) => a.file === rel && text.includes(a.contains))
      if (!allowed) violations.push({ file: rel, line, name, text: text.length > 90 ? text.slice(0, 87) + '…' : text })
    }
  }
}

const enforced = violations.filter(
  (v) => ENFORCED_FILES.has(v.file) || (ENFORCED_CATEGORIES.has(v.name) && ENFORCED_CATEGORY_FILES.has(v.file))
)

if (violations.length) {
  const mode = ENFORCE ? 'ENFORCING' : 'REPORT-ONLY (burn-down; rewritten files enforce)'
  console.log(`TOOLWORDS [${mode}]: ${violations.length} jargon hit(s) in user-visible strings:`)
  const byFile = new Map()
  for (const v of violations) {
    if (!byFile.has(v.file)) byFile.set(v.file, [])
    byFile.get(v.file).push(v)
  }
  for (const [file, vs] of byFile) {
    console.log(`  ${file} (${vs.length})${ENFORCED_FILES.has(file) ? '  ← ENFORCED' : ''}`)
    for (const v of vs.slice(0, 8)) console.log(`    L${v.line} [${v.name}] ${JSON.stringify(v.text)}`)
    if (vs.length > 8) console.log(`    … and ${vs.length - 8} more`)
  }
  if (ENFORCE) process.exit(1)
  if (enforced.length) {
    console.error(`TOOLWORDS: ${enforced.length} violation(s) under ENFORCEMENT (rewritten files / retired categories) — these fail even in report-only mode:`)
    for (const v of enforced) console.error(`  ${v.file}:L${v.line} [${v.name}] ${JSON.stringify(v.text)}`)
    process.exit(1)
  }
  console.log('TOOLWORDS: report-only pass — the count above is the burn-down; step 06 flips the rest.')
  process.exit(0)
}
console.log('TOOLWORDS: no plumbing jargon in user-visible integration strings')
