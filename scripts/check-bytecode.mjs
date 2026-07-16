#!/usr/bin/env node
// The bytecode gate (ADR 0016 §hardening, phase-accounts/07).
//
//   node scripts/check-bytecode.mjs
//
// THE RULE: the shipped main process is V8 bytecode, the sandboxed preload is not, and
// the pinned entitlement constants do not grep in plain text.
//
// Honest framing, fossilized where the check lives: bytecode raises the cost of READING
// the main process from "open an editor" to "reverse V8 bytecode" — FRICTION, never a
// wall, never to be described as security (docs/19-accounts.md §honest limits). This
// gate exists because the friction is trivially silent in both directions: a config
// regression ships readable JS again and nothing visibly changes, or someone "fixes" a
// preload bug by bytecoding it too — which requires `sandbox: false` and would trade a
// real hardening win for a deterrent. Three assertions, one per failure mode:
//
//   (a) out/main ships the SPLIT wall (ADR 0017). index.js is the three-line loader
//       stub (same path — package.json `main` and electron-builder's globs never
//       moved) and out/main/index.jsc is REAL V8 bytecode for THIS Electron's V8:
//       magic header compared against a freshly compiled dummy, then the loader's own
//       accept path (flag-hash patch + vm.Script cachedData) must not reject it. The
//       DAEMON is the deliberate exception, asserted in BOTH directions: daemon.js
//       (and every chunk it requires) must stay PLAIN JS, and index.jsc must be the
//       ONLY .jsc — the daemon is hosted by the standalone Node helper, whose V8 is
//       not Electron's, so a daemon that quietly compiles again is a helper boot
//       crash, not extra protection. Validation only — nothing from the app bundle is
//       ever executed here.
//   (b) the preload ships as READABLE SOURCE and the sandbox is intact. No .jsc under
//       out/preload or out/renderer, out/preload/index.js is plain text, and no
//       `sandbox: false` exists under src/main or src/preload (window.ts must still say
//       `sandbox: true`). Preload bytecode requires sandbox:false — the trade we refuse.
//   (c) the pinned constants are not plaintext. V8 keeps string literals readable in
//       the .jsc constant pool, so `protectedStrings` (electron.vite.config.ts) rewrites
//       the entitlement verify key and the origin table to String.fromCharCode. The
//       values are DERIVED from src/backend/core/origins.ts here (never hardcoded — the
//       same no-second-copy law ORIGINPIN enforces), each must appear NOWHERE under
//       out/main except the sourcemaps, and each MUST appear in index.js.map — the maps
//       carry the original source and never ship (`!**/*.map`), so a hit there proves
//       the scan pattern can actually find what it hunts. Obfuscation makes these
//       harder to LOCATE, not secret: object-literal KEYS (e.g. the Free limits table)
//       stay readable in the pool, and the renderer bundle keeps its own plain copies.
//
// It also proves the MECHANISM: transformArrowFunctions is off (the babel transform
// cannot handle `this`-capturing arrows in class fields), on the strength of modern V8
// eagerly compiling arrows under --no-lazy. Not taken on faith — a fixture carrying
// exactly the risky constructs (class-field arrow over `this`, async arrow, a
// fromCharCode-protected string) is compiled through the same wrap+produceCachedData
// pipeline and EXECUTED under Electron-as-Node; wrong answers or a rejection fail the
// gate on this machine before they can ship. Bytecode is bound to the exact V8 version
// + CPU arch, which is why this runs per build-matrix row and why one arch's out/ must
// never be packaged into another arch's artifact.
//
// WHY IT BUILDS, ITSELF: same law as check-prod-artifact.mjs — every sweep gate runs
// `npm run dev`, which overwrites out/ with the PLAIN-JS dev bundle (the bytecode
// plugin is inert under serve, by design). The only trustworthy artifact is one this
// gate produced. ~15s; it leaves out/ holding the production bundle.
//
// Verdict: out/bytecode-result.json, the sweep's verdict() shape ({ pass: true }).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const ORIGINS_FILE = 'src/backend/core/origins.ts'
const STUB_MAX_BYTES = 256

const failures = []
const checks = {}
const fail = (msg) => failures.push(msg)
// Each section owns a named verdict-file check: green iff IT added no failures.
const section = (name, fn) => {
  const before = failures.length
  fn()
  checks[name] = failures.length === before
}

// ── 1. Build the production artifact. Never trust the out/ that is already there. ────
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // leaks from Electron-based host terminals; breaks the spawns
try {
  execSync('npm run build', { env, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
  console.error(`\nBYTECODE: \`npm run build\` failed — cannot inspect what does not build.\n\n${out}\n`)
  process.exit(1)
}

const walk = (dir) => {
  let out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out = out.concat(walk(path))
    else out.push(path)
  }
  return out
}
const rel = (p) => relative(ROOT, p).split(sep).join('/')

const mainFiles = walk(join(ROOT, 'out', 'main'))
const jscFiles = mainFiles.filter((f) => f.endsWith('.jsc'))

// ── (a) out/main ships the split wall: index is bytecode, the daemon is NOT ──────────
section('mainShipsBytecode', () => {
  const STUB_RE = /^"use strict";\s*require\("(?:\.{1,2}\/)*bytecode-loader\.cjs"\);\s*require\("\.\/index\.jsc"\);\s*$/
  let stubBody = ''
  try {
    stubBody = readFileSync(join(ROOT, 'out/main/index.js'), 'utf8')
  } catch {
    fail('out/main/index.js is missing — the entry path must never move (package.json `main` points here)')
  }
  if (stubBody && (stubBody.length > STUB_MAX_BYTES || !STUB_RE.test(stubBody))) {
    fail(`out/main/index.js is not the three-line bytecode loader stub (${stubBody.length} bytes) — the main process is shipping readable JS`)
  }
  if (!jscFiles.some((f) => rel(f) === 'out/main/index.jsc')) {
    fail('out/main/index.jsc is missing — the index entry did not compile to bytecode')
  }
  // ONE .jsc, exactly. The daemon and every chunk it shares with index run under the
  // standalone helper (ADR 0017) — a compiled chunk there is a boot crash on a V8 that
  // never produced it. chunkAlias:['index'] (electron.vite.config.ts) is what this pins.
  const strayJsc = jscFiles.map(rel).filter((f) => f !== 'out/main/index.jsc')
  if (strayJsc.length) {
    fail(`.jsc beyond the index entry — the daemon graph must stay plain for the helper (ADR 0017):\n    ${strayJsc.join('\n    ')}`)
  }
  let daemonBody = null
  try {
    daemonBody = readFileSync(join(ROOT, 'out/main/daemon.js'))
  } catch {
    fail('out/main/daemon.js is missing — the daemon entry path must never move (daemon-client spawns it)')
  }
  if (daemonBody && (daemonBody.includes(0) || /require\("\.\/daemon\.jsc"\)/.test(daemonBody.toString('utf8').slice(0, STUB_MAX_BYTES)))) {
    fail('out/main/daemon.js is not plain readable JS — a bytecode daemon cannot boot under the standalone helper (ADR 0017)')
  }
  let loaderOk = false
  try {
    loaderOk = readFileSync(join(ROOT, 'out', 'main', 'bytecode-loader.cjs'), 'utf8').includes('Module._extensions[".jsc"]')
  } catch {
    /* missing */
  }
  if (!loaderOk) fail('out/main/bytecode-loader.cjs is missing or does not register the .jsc extension — the stub loads nothing')
})

// ── (b) the preload is readable source and the sandbox is intact ─────────────────────
section('preloadUntouchedSandboxIntact', () => {
  const foreign = [...walk(join(ROOT, 'out', 'preload')), ...walk(join(ROOT, 'out', 'renderer'))]
    .filter((f) => /\.(jsc|cjsc)$/.test(f))
    .map(rel)
  if (foreign.length) fail(`bytecode outside out/main (preload bytecode forces sandbox:false — the trade we refuse):\n    ${foreign.join('\n    ')}`)

  let preloadBody = null
  try {
    preloadBody = readFileSync(join(ROOT, 'out', 'preload', 'index.js'))
  } catch {
    fail('out/preload/index.js is missing — the pattern is blind')
  }
  if (preloadBody && (preloadBody.includes(0) || !preloadBody.toString('utf8').startsWith('"use strict"'))) {
    fail('out/preload/index.js is not plain readable JS — the preload must ship as source')
  }

  const srcFiles = (dir) => walk(join(ROOT, dir)).filter((f) => /\.(ts|tsx)$/.test(f))
  const sandboxHits = []
  for (const file of [...srcFiles('src/main'), ...srcFiles('src/preload')]) {
    if (/sandbox:\s*false/.test(readFileSync(file, 'utf8'))) sandboxHits.push(rel(file))
  }
  if (sandboxHits.length) fail(`\`sandbox: false\` in shipped source (the hardening win bytecode must never buy back):\n    ${sandboxHits.join('\n    ')}`)
  if (!/sandbox:\s*true/.test(readFileSync(join(ROOT, 'src/main/window.ts'), 'utf8'))) {
    fail('src/main/window.ts no longer declares `sandbox: true` — the preload sandbox has come unpinned')
  }
})

// ── (c) the pinned constants do not grep in plain text ───────────────────────────────
// Derived from origins.ts, never hardcoded (the ORIGINPIN no-second-copy law). The
// sourcemaps carry the ORIGINAL source and never ship — a hit there is the proof the
// scan pattern still finds what it hunts; a miss there means the pattern rotted.
let secrets = []
section('constantsNotPlaintext', () => {
  const origins = readFileSync(join(ROOT, ORIGINS_FILE), 'utf8')
  const pinnedUrls = [...origins.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1])
  const pemBase64 = origins.match(/-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/=]+)\\n/)?.[1] ?? ''
  if (!pinnedUrls.length) fail(`${ORIGINS_FILE}: no pinned 'http(s)://…' literal found — the pattern is blind`)
  if (pemBase64.length < 40) fail(`${ORIGINS_FILE}: could not extract the entitlement verify key body — the pattern is blind`)
  secrets = [...pinnedUrls, pemBase64].filter(Boolean)

  const plaintextHits = []
  for (const file of mainFiles.filter((f) => !f.endsWith('.map'))) {
    const body = readFileSync(file, 'latin1') // .jsc is binary; one-byte strings grep raw
    for (const s of secrets) if (body.includes(s)) plaintextHits.push(`${rel(file)}: ${s.slice(0, 40)}…`)
  }
  if (plaintextHits.length) {
    fail(`pinned constants readable in the shipped main bundle (protectedStrings has come unwired):\n    ${plaintextHits.join('\n    ')}`)
  }
  let mapBody = ''
  try {
    mapBody = readFileSync(join(ROOT, 'out', 'main', 'index.js.map'), 'utf8')
  } catch {
    /* handled by `blind` below */
  }
  const blind = secrets.filter((s) => !mapBody.includes(s))
  if (blind.length) {
    fail(`scan strings absent from out/main/index.js.map — the pattern is blind, not the bundle clean:\n    ${blind.map((s) => `${s.slice(0, 40)}…`).join('\n    ')}`)
  }
})

// ── (d) the V8 probe: real bytecode for THIS Electron, and the mechanism EXECUTES ────
// One Electron-as-Node spawn. Validates every shipped .jsc exactly the way the shipped
// loader will accept it (flag-hash patch + vm.Script cachedData — compile, never run),
// compares magic headers against a freshly compiled dummy, then compiles AND runs the
// risky-constructs fixture (class-field arrow over `this`, async arrow, protected
// string) through the same wrap+produceCachedData pipeline the build used.
const PROBE = String.raw`
const fs = require('fs')
const vm = require('vm')
const v8 = require('v8')
const { wrap } = require('module')
v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')
const [, , ...jscPaths] = process.argv
const dummy = new vm.Script('', { produceCachedData: true }).createCachedData()
const buffer2Number = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
const dummySource = (len) => (len > 1 ? '"' + String.fromCharCode(8203).repeat(len - 2) + '"' : '') // U+200B, the loader's own filler
const results = { files: {}, fixture: null, electron: process.versions.electron, v8: process.versions.v8, arch: process.arch }
for (const p of jscPaths) {
  const buf = fs.readFileSync(p)
  const magicOk = buf.length > 16 && buf.slice(0, 8).equals(dummy.slice(0, 8))
  if (!magicOk) {
    results.files[p] = { magicOk, accepted: false, bytes: buf.length }
    continue // a garbage length header could ask for gigabytes of dummy source
  }
  dummy.slice(12, 16).copy(buf, 12) // the loader's flag-hash patch, verbatim
  let accepted = false
  try {
    const s = new vm.Script(dummySource(buffer2Number(buf, 8)), { filename: p, cachedData: buf })
    accepted = !s.cachedDataRejected
  } catch {
    accepted = false
  }
  results.files[p] = { magicOk, accepted, bytes: buf.length }
}
const FIXTURE = [
  'class C { onA = (x) => this.double(x); double(n) { return n * 2 } }',
  'const asyncArrow = async (n) => n + 1',
  'const KEY = (function (arr) { return String.fromCharCode(...arr) })([111, 107])',
  'module.exports = (async () => ({ a: new C().onA(21), b: await asyncArrow(41), k: KEY }))()'
].join('\n')
const compiled = new vm.Script(wrap(FIXTURE), { produceCachedData: true }).createCachedData()
const script = new vm.Script(dummySource(wrap(FIXTURE).length), { filename: 'fixture.jsc', cachedData: compiled })
if (script.cachedDataRejected) {
  process.stdout.write(JSON.stringify({ ...results, fixture: { rejected: true } }))
} else {
  const m = { exports: {} }
  script.runInThisContext()(m.exports, require, m, 'fixture.jsc', '.')
  Promise.resolve(m.exports).then((r) => {
    process.stdout.write(JSON.stringify({ ...results, fixture: { rejected: false, ...r } }))
  })
}
`
let probe = null
section('v8ProbeValid', () => {
  const electronBin = createRequire(import.meta.url)('electron')
  const scratch = mkdtempSync(join(tmpdir(), 'bytecode-'))
  try {
    const probePath = join(scratch, 'probe.cjs')
    writeFileSync(probePath, PROBE)
    const r = spawnSync(electronBin, [probePath, ...jscFiles], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    if (r.status !== 0 || !r.stdout) {
      fail(`the V8 probe died (exit ${r.status ?? r.signal}): ${`${r.stderr}`.trim().slice(0, 400)}`)
      return
    }
    probe = JSON.parse(r.stdout)
  } catch (e) {
    fail(`the V8 probe could not run: ${e instanceof Error ? e.message : String(e)}`)
    return
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (!jscFiles.length) fail('no .jsc files reached the probe — the pattern is blind')
  for (const [file, v] of Object.entries(probe.files)) {
    if (!v.magicOk) fail(`${rel(file)}: magic header does not match this Electron's V8 — not bytecode, or compiled by a different version/arch`)
    else if (!v.accepted) fail(`${rel(file)}: V8 REJECTED the cached data — the shipped loader would throw at boot`)
  }
  const f = probe.fixture
  if (!f || f.rejected || f.a !== 42 || f.b !== 42 || f.k !== 'ok') {
    fail(`the mechanism fixture failed under Electron-as-Node (${JSON.stringify(f)}) — arrows/protected strings do not survive this V8; do not ship bytecode built here`)
  }
})

// ── Verdict ──────────────────────────────────────────────────────────────────────────
const pass = failures.length === 0
mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(
  join(ROOT, 'out', 'bytecode-result.json'),
  JSON.stringify({ pass, ...checks, probe, jsc: jscFiles.map((f) => ({ file: rel(f), bytes: statSync(f).size })) }, null, 2)
)

if (!pass) {
  console.error('\nBYTECODE: the shipped main must be V8 bytecode; the sandboxed preload must not be.\n')
  for (const f of failures) console.error(`  ${f}`)
  console.error('\nThe knob is `build.bytecode` in electron.vite.config.ts — MAIN block only, with the')
  console.error('pinned constants in `protectedStrings`. This is friction against casual reading, never')
  console.error('security (docs/19-accounts.md §honest limits) — and it is per-arch: each build-matrix')
  console.error('row compiles its own .jsc with its own local Electron.\n')
  process.exit(1)
}

const mb = (n) => (n / 1024 / 1024).toFixed(1)
const totalJsc = jscFiles.reduce((n, f) => n + statSync(f).size, 0)
console.log(
  `  bytecode OK — ${jscFiles.length} .jsc chunks (${mb(totalJsc)} MB) for Electron ${probe.electron}/V8 ${probe.v8} (${probe.arch}); ` +
    `preload readable + sandbox:true; ${secrets.length} pinned constants not plaintext (maps prove the pattern)`
)
