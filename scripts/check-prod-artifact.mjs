#!/usr/bin/env node
// The production-artifact gate (audit finding 41).
//
//   node scripts/check-prod-artifact.mjs
//
// THE RULE: the test harness is not in the shipped app.
//
// It used to be. src/main/index.ts statically imported ~100 `run*Smoke` modules, the gallery/shot
// capture rig and an 86-branch MOGGING_<GATE> dispatcher, so a THIRD of out/main/index.js — which
// electron-builder globs straight into app.asar — was a test rig that every user downloaded,
// virus-scanned and loaded into the main process on launch, and that an environment variable could
// wake inside a real install. The fix (electron.vite.config.ts) gives dev and build DIFFERENT
// entries over one shared boot.ts: `build` takes src/main/index.ts (production), `serve` takes
// src/main/index.dev.ts (production + harness). This gate is what keeps them different — one
// stray `import { runXxxSmoke }` in the production entry silently puts it all back.
//
// Code-splitting could not have fixed it and must not be proposed again: electron-builder.yml globs
// `out/main/**/*`, so rollup's chunks ship anyway — and the trigger strings and the dispatcher stay
// in index.js regardless, because they are what DECIDES whether to load a chunk. Hence this gate
// greps the chunks too.
//
// WHY IT BUILDS, ITSELF: every gate in scripts/qa-smokes.sh runs `npm run dev`, and dev OVERWRITES
// out/ with the harness bundle. A gate that merely read out/ would inspect whatever happened to be
// there — the DEV build (and fail for the wrong reason), or a stale prod build (and pass while
// broken). The only trustworthy artifact is one this gate produced. It costs a ~10s build; it
// leaves out/ holding the PRODUCTION bundle (the next `npm run dev` rewrites it).
//
// Same family as check-gates.mjs — but inverted. check-gates.mjs asserts the dev entry knows EVERY
// gate; this one asserts the production entry knows NONE of them.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const DEV_ENTRY = 'src/main/index.dev.ts'
const SWEEP = 'scripts/qa-smokes.sh'
const MAIN_BUNDLE = 'out/main/index.js'

// Runtime knobs, NOT harness: state isolation, the dev/prod channel split, the sweep's own subset
// selector, the documented daemon-failure workaround, the Linux CI keyring, the soft-GL CI relax,
// and the fake update feed. They are EXPECTED in a production build — denylisting them would make
// this gate wrong, not stricter.
const PRODUCTION_KNOBS = new Set([
  'MOGGING_USERDATA',
  'MOGGING_CHANNEL',
  'MOGGING_GATES',
  'MOGGING_INPROC',
  'MOGGING_CI_KEYRING',
  'MOGGING_CI_GPU',
  'MOGGING_FAKE_UPDATE'
])

// Harness triggers that are NOT gate names, so the `run_smoke` rows below cannot derive them —
// but which are the same defect and were in the shipped bundle until the ports landed. A gate
// trigger is only the loudest example: what makes any of these a bug is that an environment
// variable, inside a real signed install, could wake a fault or a fixture that has no business
// existing there at all.
//
// MOGGING_ASYNCFAIL could reject or permanently HANG eleven IPC channels. MOGGING_PERSIST_FAIL
// could refuse every workspace save. MOGGING_USAGE_* / MOGGING_GALLERY could swap the FAKE usage
// adapter in and show a user fabricated spend as their own. They now live only in the dev graph
// (src/main/harness-install.ts, behind fault-port.ts / fixture-port.ts). Named here so they
// cannot come back the way they arrived — quietly, one import at a time.
const HARNESS_TRIGGERS = [
  'MOGGING_ASYNCFAIL', // async-audit-faults.ts — reject/hang/delay any named channel
  'MOGGING_PERSIST_FAIL', // app-settings.ts — break open/load/save
  'MOGGING_PERSIST_EXPORT_PATH', // app-settings.ts — skip the native save dialog
  'MOGGING_TEST_NO_VAULT', // browser-dock.ts — force agent-web persistence off
  'MOGGING_GALLERY', // usage.ts — the capture rig's fixture world
  'MOGGING_USAGE_CADENCE_MS', // usage.ts — fixture poll cadence
  'MOGGING_USAGE_COSTDIR', // usage.ts — fixture cost-scan root
  'MOGGING_USAGE_STATUS', // usage.ts — fixture provider-status body
  'MOGGING_USAGE_FIXTURE' // @backend fake-adapter — the fabricated numbers themselves
]

const fail = (msg) => {
  console.error(`\n${msg}\n`)
  process.exit(1)
}

// ── 1. Build the PRODUCTION entry. Never trust the out/ that is already there.
// ELECTRON_RUN_AS_NODE leaks in from Electron-based host terminals and breaks electron-vite's own
// spawns; the config clears it too, but a gate must not depend on that.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  execSync('npm run build', { env, stdio: 'pipe' })
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
  fail(`PROD ARTIFACT: \`npm run build\` failed — cannot inspect what does not build.\n\n${out}`)
}

// ── 2. DERIVE the denylist. Hardcoding it would rot the moment a gate is added.
const dev = readFileSync(DEV_ENTRY, 'utf8')
const imports = dev
  .split('\n')
  .filter((l) => /^import\s/.test(l))
  .join('\n')
const symbols = [...new Set([...imports.matchAll(/\brun[A-Za-z0-9]*Smoke\b/g)].map((m) => m[0]))]
if (symbols.length < 50) {
  fail(`PROD ARTIFACT: found only ${symbols.length} run*Smoke imports in ${DEV_ENTRY} — the pattern is blind.`)
}
symbols.push('runGallery', 'runShot', 'SMOKE_ENV') // the capture rig + the allowlist itself

// Same rows, same regex, as check-gates.mjs: the sweep IS the list of gates.
const sweep = readFileSync(SWEEP, 'utf8')
const gates = [...new Set([...sweep.matchAll(/^run_smoke\s+(\S+)\s+(MOGGING_\w+)/gm)].map((m) => m[2]))]
if (!gates.length) fail(`PROD ARTIFACT: found no \`run_smoke\` rows in ${SWEEP} — the pattern is blind.`)
const triggers = [...new Set([...gates, ...HARNESS_TRIGGERS])].filter((g) => !PRODUCTION_KNOBS.has(g))

// ── 3. Scan every bundle electron-builder packages. NOT the .map files: they carry the original
// TypeScript (comments and all) and electron-builder excludes them (`!**/*.map`).
const walk = (dir) => {
  let out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out = out.concat(walk(path))
    else if (path.endsWith('.js')) out.push(path.replace(/\\/g, '/'))
  }
  return out
}
const bundles = ['out/main', 'out/preload', 'out/renderer'].flatMap(walk)
if (!bundles.length) fail('PROD ARTIFACT: the build produced no .js under out/ — the pattern is blind.')

// ZERO tolerance, both halves. There is no allowance list any more: a harness symbol and an env
// trigger are the same bug wearing different clothes, and the day one of them is "just this one,
// just for now" is the day the exception becomes cover for the next regression.
const leaked = []
for (const file of bundles) {
  const body = readFileSync(file, 'utf8')
  // Minification renames identifiers but never touches string-literal contents, so the env strings
  // are the durable half of this check; the symbols are the precise half.
  for (const token of [...symbols, ...triggers]) {
    if (new RegExp(`\\b${token}\\b`).test(body)) leaked.push({ file, token })
  }
}

// ── 4. Verdict.
if (leaked.length) {
  console.error('\nPROD ARTIFACT: the test harness is in the shipped bundle.\n')
  for (const { file, token } of leaked) console.error(`  ${file.padEnd(24)} ${token}`)
  console.error('\nThe production entry (src/main/index.ts) must import boot.ts and nothing from the')
  console.error(`harness. Gates live in ${DEV_ENTRY}, which electron-vite uses for \`serve\` only.`)
  console.error('If you added a smoke, dispatch it there — never here.')
  console.error('')
  console.error('An env TRIGGER (a MOGGING_* string) means a PRODUCTION module is reading it — a fault or')
  console.error('a fixture that a shipped, signed app could be told to wake with an environment variable.')
  console.error('The answer is never to list it here: it is a PORT. src/main/fault-port.ts and')
  console.error('src/main/fixture-port.ts are inert in production and installed by the dev entry')
  console.error('(src/main/harness-install.ts) — put the seam there and the trigger goes with it.\n')
  process.exit(1)
}

const kb = (readFileSync(MAIN_BUNDLE).length / 1024).toFixed(1)
console.log(
  `  prod artifact OK — ${MAIN_BUNDLE} ${kb} kB, 0 of ${symbols.length} harness symbols and ` +
    `0 of ${triggers.length} env triggers across ${bundles.length} bundles`
)
