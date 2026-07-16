#!/usr/bin/env node
// The origin-pin gate (ADR 0015).
//
//   node scripts/check-originpin.mjs
//
// THE RULE: a shipped build talks to exactly the origins compiled into it. No
// environment variable may repoint where the app reaches a pinned server.
//
// The bug it fossilizes: `MOGGING_REGISTRY_BASE` (catalog.ts) let an env var repoint
// the integrations-registry fetch inside a real, signed install. For a community feed
// that is harmless; as a PATTERN it is a licensing bypass on the day an entitlement
// endpoint exists (`…_ENTITLE_BASE=https://attacker/always-pro`). The fix is a single
// frozen in-code table — src/backend/core/origins.ts — and this gate is what keeps
// the fix fixed:
//
//   (a) no `process.env.MOGGING_*_BASE` read survives anywhere in src/ or bin/, and
//       the real + reserved override names appear nowhere in shipped source AT ALL
//       (comments included — the prod-artifact scan greps built bundles for these
//       exact strings, so a comment that survives a build config change would trip
//       it; simpler to keep the names out of source entirely);
//   (b) origins.ts is the ONLY origin source: present, `Object.freeze`d, `as const`,
//       env-free — and every URL it pins appears in no other src/bin file, so a
//       second copy of an origin cannot drift away from the pin;
//   (c) the two sibling gates BITE. The prod-artifact banlist carries all four names
//       (and none has crept into its PRODUCTION_KNOBS escape hatch), and the wording
//       gate actually FAILS a fixture containing a retired absolute — proven by
//       running it against a sabotaged scratch cwd (must exit 1, naming the pattern)
//       and then a reverted one (must exit 0). Sabotage-and-revert without ever
//       touching the repo.
//
// Same family as check-prod-artifact.mjs (what must never reach the artifact) and
// check-credential-wording.mjs (what copy must never claim) — this one holds the seam
// between them: where the artifact is allowed to TALK.
//
// Verdict: out/originpin-result.json, the sweep's verdict() shape ({ pass: true }).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const ORIGINS_FILE = 'src/backend/core/origins.ts'
const CATALOG_FILE = 'src/backend/features/integrations/catalog.ts'
const PROD_GATE = 'scripts/check-prod-artifact.mjs'
const WORDING_GATE = 'scripts/check-credential-wording.mjs'

// Built from halves so this file does not itself carry the banned tokens it hunts —
// the sweep greps source for them, and a gate must not be its own violation.
const BASE_NAMES = ['REGISTRY', 'ENTITLE', 'IDP', 'UPDATE'].map((n) => `MOGGING_${n}_BASE`)

const failures = []
const checks = {}

// ── (a) shipped source reads no MOGGING_*_BASE — and never names one ────────────────
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return EXTS.some((e) => path.endsWith(e)) ? [path] : []
  })

const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'bin'))]
if (sources.length < 100) {
  failures.push(`scanned only ${sources.length} files under src/ + bin/ — the pattern is blind`)
}

// The \b after BASE keeps MOGGING_DEV_BASEURL (a dev-arm knob, not an origin) legal.
const ENV_READ = /process\.env\.MOGGING_\w*_BASE\b/
const ANY_NAME = new RegExp(`\\b(${BASE_NAMES.join('|')})\\b`)
const sourceHits = []
for (const file of sources) {
  const body = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).split(sep).join('/')
  if (ENV_READ.test(body)) sourceHits.push(`${rel}: env read (${body.match(ENV_READ)[0]})`)
  else if (ANY_NAME.test(body)) sourceHits.push(`${rel}: names ${body.match(ANY_NAME)[0]}`)
}
checks.noEnvOverrideInSource = sourceHits.length === 0
if (sourceHits.length) failures.push(`origin-override names in shipped source:\n    ${sourceHits.join('\n    ')}`)

// ── (b) origins.ts: present, frozen, env-free, and the SOLE origin source ───────────
let pinnedUrls = []
if (!existsSync(join(ROOT, ORIGINS_FILE))) {
  checks.originsPinned = false
  failures.push(`${ORIGINS_FILE} is missing — the origin table IS the fix; without it there is nothing pinning anything`)
} else {
  const origins = readFileSync(join(ROOT, ORIGINS_FILE), 'utf8')
  pinnedUrls = [...origins.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1])
  const frozen = /Object\.freeze\(/.test(origins) && /as const/.test(origins)
  const envFree = !/process\.env/.test(origins)
  checks.originsPinned = frozen && envFree && pinnedUrls.length > 0
  if (!frozen) failures.push(`${ORIGINS_FILE}: the table must be Object.freeze(...) as const — a mutable export is a runtime override waiting for a caller`)
  if (!envFree) failures.push(`${ORIGINS_FILE}: reads process.env — the whole point of the table is that it cannot`)
  if (!pinnedUrls.length) failures.push(`${ORIGINS_FILE}: no 'http(s)://…' literal found — the pattern is blind`)

  const catalog = existsSync(join(ROOT, CATALOG_FILE)) ? readFileSync(join(ROOT, CATALOG_FILE), 'utf8') : ''
  checks.catalogUsesPin = /core\/origins/.test(catalog) && /ORIGINS\.registry/.test(catalog)
  if (!checks.catalogUsesPin) failures.push(`${CATALOG_FILE}: no longer imports ORIGINS.registry from core/origins — the registry origin has come unpinned`)

  const copies = []
  for (const file of sources) {
    const rel = relative(ROOT, file).split(sep).join('/')
    if (rel === ORIGINS_FILE) continue
    const body = readFileSync(file, 'utf8')
    for (const url of pinnedUrls) if (body.includes(url)) copies.push(`${rel}: duplicates ${url}`)
  }
  checks.soleSource = copies.length === 0
  if (copies.length) failures.push(`a pinned origin exists OUTSIDE the table (import ORIGINS instead — a copy is where drift starts):\n    ${copies.join('\n    ')}`)
}

// ── (c1) the prod-artifact banlist carries all four names, none as a "knob" ─────────
const prodGate = readFileSync(join(ROOT, PROD_GATE), 'utf8')
const triggersBlock = prodGate.match(/const HARNESS_TRIGGERS = \[[\s\S]*?\n\]/)?.[0] ?? ''
const knobsBlock = prodGate.match(/const PRODUCTION_KNOBS = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? ''
if (!triggersBlock || !knobsBlock) {
  checks.banlistCarriesNames = false
  failures.push(`${PROD_GATE}: could not find HARNESS_TRIGGERS / PRODUCTION_KNOBS — the pattern is blind`)
} else {
  const missing = BASE_NAMES.filter((n) => !triggersBlock.includes(`'${n}'`))
  const excused = BASE_NAMES.filter((n) => knobsBlock.includes(`'${n}'`))
  checks.banlistCarriesNames = missing.length === 0 && excused.length === 0
  if (missing.length) failures.push(`${PROD_GATE}: banlist is missing ${missing.join(', ')} — a reintroduced override would ship`)
  if (excused.length) failures.push(`${PROD_GATE}: ${excused.join(', ')} listed as a PRODUCTION KNOB — an origin override is never a runtime knob`)
}

// ── (c2) the wording gate bites: sabotage a scratch cwd, then revert it ─────────────
// The gate scans <cwd>/docs/**.md + <cwd>/README.md and needs >= 2 files, so a scratch
// dir with one sabotaged doc and a clean README exercises the REAL script end to end.
const scratch = mkdtempSync(join(tmpdir(), 'originpin-'))
try {
  mkdirSync(join(scratch, 'docs'))
  writeFileSync(join(scratch, 'README.md'), 'A clean fixture README.\n')
  writeFileSync(join(scratch, 'docs', 'claim.md'), 'Totally free forever — no subscription to us.\n')
  const sabotaged = spawnSync(process.execPath, [join(ROOT, WORDING_GATE)], { cwd: scratch, encoding: 'utf8', windowsHide: true })
  const bit = sabotaged.status === 1 && /no-subscription-to-us/.test(`${sabotaged.stdout}${sabotaged.stderr}`)

  writeFileSync(join(scratch, 'docs', 'claim.md'), 'The free local core needs no account and works fully offline.\n')
  const reverted = spawnSync(process.execPath, [join(ROOT, WORDING_GATE)], { cwd: scratch, encoding: 'utf8', windowsHide: true })
  const cleared = reverted.status === 0

  checks.wordingGateBites = bit && cleared
  if (!bit) failures.push(`${WORDING_GATE}: did NOT fail a fixture carrying a retired absolute (exit ${sabotaged.status}) — the retirement patterns have gone blind`)
  if (!cleared) failures.push(`${WORDING_GATE}: failed a CLEAN fixture (exit ${reverted.status}) — a gate that bites everything proves nothing`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ── Verdict ──────────────────────────────────────────────────────────────────────────
const pass = failures.length === 0
mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(join(ROOT, 'out', 'originpin-result.json'), JSON.stringify({ pass, ...checks, pinnedOrigins: pinnedUrls, scanned: sources.length }, null, 2))

if (!pass) {
  console.error('\nORIGINPIN: an env var must never repoint where a shipped build talks.\n')
  for (const f of failures) console.error(`  ${f}`)
  console.error(`\nThe law is ADR 0015 §6: every remote origin is an in-code constant in ${ORIGINS_FILE},`)
  console.error('one frozen table, decided at build time. A test that needs a fixture server passes a')
  console.error('baseUrl PARAMETER at the call site (see the mcpcat smoke) — nothing reads the environment.\n')
  process.exit(1)
}

console.log(
  `  origin pin OK — ${pinnedUrls.length} origin(s) pinned in ${ORIGINS_FILE}; ${sources.length} files clean; ` +
    'banlist carries all 4 names; wording gate bit the sabotage and cleared the revert'
)
