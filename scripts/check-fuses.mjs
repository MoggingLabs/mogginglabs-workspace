#!/usr/bin/env node
// The fuse-wall gate (ADR 0016 §hardening).
//
//   node scripts/check-fuses.mjs                      # package, then verify
//   MOGGING_FUSES_APP=<binary|.app> node scripts/check-fuses.mjs   # verify a prebuilt
//
// THE RULE: the packaged artifact carries EXACTLY the fuse wall electron-builder.yml
// declares — tamper-evident, and stripped of its living-off-the-land levers.
//
// Fuses are compile-time-shaped booleans burned into the Electron binary at PACK time
// (`electronFuses` in electron-builder.yml). They are also trivially silent: a config
// key typo, an electron-builder regression, or a well-meant "temporary" re-enable all
// produce a bit-identical-LOOKING artifact that quietly honors `--inspect` again. The
// only honest check is reading the wall off the artifact itself — so this gate does,
// with @electron/fuses, the same library electron-builder flips with.
//
// The wall (this table and electron-builder.yml must always agree; that is the drift
// this catches):
//
//   RunAsNode                              DISABLE  the runtime split's prize (ADR 0017):
//                                                   daemon/MCP/CLI ride the standalone
//                                                   helper; the signed binary is not a
//                                                   Node interpreter anymore
//   EnableCookieEncryption                 ENABLE
//   EnableNodeOptionsEnvironmentVariable   DISABLE  NODE_OPTIONS/NODE_EXTRA_CA_CERTS ignored
//   EnableNodeCliInspectArguments          DISABLE  no debugger attaches to a shipped process
//   EnableEmbeddedAsarIntegrityValidation  ENABLE   hand-edited app.asar refuses to load
//   OnlyLoadAppFromAsar                    ENABLE   …and app.asar is the only load path
//
// It then PROVES the integrity fuse bites: flip one byte inside app.asar's header,
// launch the binary, require a fast FATAL "Integrity check failed" exit, restore the
// byte (sabotage-and-revert, ORIGINPIN's pattern). Windows/macOS only — Electron
// enforces asar integrity there (>= 30 / >= 16); on Linux the fuse is SET but inert,
// which docs/18 states plainly. Two more stated caveats: the outside-the-asar set
// (node-pty, better-sqlite3, bin/**, out/main/daemon.js + chunks, and the node-helper
// resources — ADR 0017) is covered only by the code signature (the operator's deferred
// step), and ELECTRON_RUN_AS_NODE is still scrubbed from the env — the packaged exe now
// IGNORES it (RunAsNode is off; a leaked =1 once made a tampered exe boot as plain Node
// and exit 0 without loading the asar, measured 2026-07-15), but the build/packaging
// spawns this gate runs are dev Electron and electron-vite, which have no fuses.
//
// WHY IT PACKAGES, ITSELF: same law as check-prod-artifact.mjs — the only trustworthy
// artifact is one this gate produced. CI rows that run right after their own packaging
// step point MOGGING_FUSES_APP at that artifact instead (release must fail on drift,
// not re-package around it).
//
// Verdict: out/fuses-result.json, the sweep's verdict() shape ({ pass: true }).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses'

const ROOT = process.cwd()
const failures = []

// The EXACT wall. Step 09 (the runtime split, ADR 0017) flipped RunAsNode here and in
// electron-builder.yml together — re-enabling it is the drift this gate now refuses.
const EXPECTED = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE
}

const fail = (msg) => failures.push(msg)

// ── 1. The artifact: a prebuilt one (CI), or package it ourselves ───────────────────
// ELECTRON_RUN_AS_NODE leaks from Electron-based host terminals and breaks both
// electron-vite's spawns and any Electron binary this gate launches.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// The binary inside an unpacked/packaged directory, per platform. Never guess names:
// win takes the one top-level .exe, mac the one .app, linux the one executable that
// is not an Electron helper (electron-builder derives the name; a rename must not
// silently blind this gate).
const resolveBinary = (dir) => {
  if (!existsSync(dir)) return ''
  if (process.platform === 'win32') {
    const exe = readdirSync(dir).find((f) => f.endsWith('.exe'))
    return exe ? join(dir, exe) : ''
  }
  if (process.platform === 'darwin') {
    const app = readdirSync(dir).find((f) => f.endsWith('.app'))
    return app ? join(dir, app) : ''
  }
  const helpers = new Set(['chrome-sandbox', 'chrome_crashpad_handler'])
  const bin = readdirSync(dir).find((f) => {
    const st = statSync(join(dir, f))
    return st.isFile() && st.mode & 0o111 && !helpers.has(f) && !/\.(so(\.\d+)?|pak|bin|dat|json|txt|html)$/.test(f)
  })
  return bin ? join(dir, bin) : ''
}

// MOGGING_FUSES_APP accepts the binary / .app itself OR the directory holding it
// (dist/win-unpacked, dist/mac-arm64, dist/linux-unpacked) — CI rows pass the dir
// their own packaging step just produced.
let appPath = process.env.MOGGING_FUSES_APP ?? ''
let packagedHere = false
if (appPath && !appPath.endsWith('.app') && existsSync(appPath) && statSync(appPath).isDirectory()) {
  appPath = resolveBinary(appPath)
}
if (!appPath) {
  packagedHere = true
  try {
    execSync('npm run build', { env, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
    // Same flags as CI/release packaging: trust the postinstall's electron-ABI natives
    // (the internal @electron/rebuild spawn is the one that hangs CI images).
    execSync('npx electron-builder --dir --publish never -c.npmRebuild=false -c.buildDependenciesFromSource=false', {
      env,
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.slice(-4000)
    console.error(`\nFUSES: packaging failed — cannot read fuses off an artifact that does not exist.\n\n${out}\n`)
    process.exit(1)
  }
  const unpacked = process.platform === 'win32' ? 'win-unpacked' : process.platform === 'darwin' ? readdirSync(join(ROOT, 'dist')).find((d) => d.startsWith('mac')) ?? 'mac' : 'linux-unpacked'
  appPath = resolveBinary(join(ROOT, 'dist', unpacked))
}
if (!appPath || !existsSync(appPath)) {
  console.error(`\nFUSES: no packaged binary at "${appPath || '(unresolved)'}" — the pattern is blind.\n`)
  process.exit(1)
}
appPath = resolve(appPath)

// ── 2. Read the wall off the artifact ───────────────────────────────────────────────
const wire = await getCurrentFuseWire(appPath)
const wall = {}
for (const [key, value] of Object.entries(wire)) {
  if (key === 'version' || key === 'resetAdHocDarwinSignature') continue
  wall[FuseV1Options[key] ?? key] = FuseState[value] ?? value
}
for (const [option, want] of Object.entries(EXPECTED)) {
  const got = wire[option]
  if (got !== want) {
    fail(`${FuseV1Options[option]}: artifact reads ${FuseState[got] ?? got}, the wall says ${FuseState[want]}`)
  }
}

// ── 2b. RunAsNode OFF is only safe if the helper it moved the daemon onto ACTUALLY
// SHIPPED, complete (ADR 0017). This gate holds the packaged artifact, so it is the one
// place that can catch the omission — and it already did once: electron-builder strips
// any `node_modules` segment from an extraResources copy, so the helper's natives shipped
// EMPTY (daemon can't load node-pty → no terminals) while every other gate stayed green.
// resources/ is beside the binary (win: <dir>/resources, mac: <app>/Contents/Resources).
const resourcesDir = appPath.endsWith('.app')
  ? join(appPath, 'Contents', 'Resources')
  : join(dirname(appPath), 'resources')
const helperExe = process.platform === 'win32' ? 'mogging-node.exe' : 'mogging-node'
const helperDir = join(resourcesDir, 'node-helper')
const helper = { present: false, natives: {} }
if (!existsSync(join(helperDir, helperExe))) {
  fail(`no standalone helper at resources/node-helper/${helperExe} — runAsNode is OFF but the daemon has no host (ADR 0017)`)
} else {
  helper.present = true
  // The daemon's two ABI-bound requires must be real files under the SHIPPED deps dir
  // (node_deps, NOT node_modules — electron-builder would strip that). A .node under each
  // is the honest proof the natives rode along, not just the folders.
  const depsDir = join(helperDir, 'node_deps')
  const hasNodeFile = (pkgDir) => {
    const roots = [join(pkgDir, 'build', 'Release'), join(pkgDir, 'prebuilds')]
    const walk = (d) => {
      let found = false
      let entries = []
      try {
        entries = readdirSync(d, { withFileTypes: true })
      } catch {
        return false
      }
      for (const e of entries) {
        if (found) break
        if (e.isDirectory()) found = walk(join(d, e.name))
        else if (e.name.endsWith('.node')) found = true
      }
      return found
    }
    return roots.some((r) => existsSync(r) && walk(r))
  }
  for (const pkg of ['node-pty', 'better-sqlite3']) {
    const ok = hasNodeFile(join(depsDir, pkg))
    helper.natives[pkg] = ok
    if (!ok) fail(`resources/node-helper/node_deps/${pkg} carries no .node binary — the helper cannot host the daemon (electron-builder likely stripped node_modules; ship it as node_deps)`)
  }
}

// ── 3. Prove the integrity fuse BITES (win32/darwin; Linux does not enforce it) ─────
const tamper = { ran: false, bit: null, status: null, ms: null }
if (process.platform !== 'linux') {
  const asar = appPath.endsWith('.app')
    ? join(appPath, 'Contents', 'Resources', 'app.asar')
    : join(dirname(appPath), 'resources', 'app.asar')
  const launchBin = appPath.endsWith('.app')
    ? join(appPath, 'Contents', 'MacOS', readdirSync(join(appPath, 'Contents', 'MacOS'))[0])
    : appPath
  if (!existsSync(asar)) {
    fail(`no app.asar next to the binary (${asar}) — the files/asar config has moved and this gate went blind`)
  } else {
    // Byte 40 sits inside the asar HEADER json, so the header hash check fires at
    // BOOT — before one line of app code runs (no window, no daemon, no config write).
    const bytes = readFileSync(asar)
    bytes[40] ^= 0xff
    writeFileSync(asar, bytes)
    const iso = mkdtempSync(join(tmpdir(), 'fuses-'))
    try {
      const t0 = Date.now()
      const probe = spawnSync(launchBin, [], {
        timeout: 30000,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...env, MOGGING_USERDATA: join(iso, 'ud'), LOCALAPPDATA: join(iso, 'local'), XDG_RUNTIME_DIR: join(iso, 'local') }
      })
      tamper.ran = true
      tamper.ms = Date.now() - t0
      tamper.status = probe.status ?? probe.signal
      // Three outcomes, and only one is a pass. Timeout-kill means the app BOOTED on a
      // tampered asar (spawnSync kills it and reports a signal — which must not read
      // as "died"). A fast self-exit must also NAME the integrity failure on stderr —
      // except on a SIGNED mac artifact, where codesign enforcement kills the process
      // before Electron can print; there, refusing to load is the whole claim.
      const timedOut = probe.error?.code === 'ETIMEDOUT'
      const died = !timedOut && ((probe.status !== null && probe.status !== 0) || probe.signal !== null)
      const named = /Integrity check failed/i.test(`${probe.stderr ?? ''}${probe.stdout ?? ''}`)
      tamper.bit = died && (named || process.platform === 'darwin')
      tamper.flavor = named ? 'integrity-fatal' : died ? 'killed-before-print (codesign)' : timedOut ? 'BOOTED (timeout-killed)' : 'exited clean'
      if (!tamper.bit) {
        fail(
          `a hand-edited app.asar did NOT refuse to load (exit ${probe.status}, signal ${probe.signal}, ${tamper.ms}ms, ` +
            `${tamper.flavor}) — the embedded header hash is missing or the fuse is off`
        )
      }
    } finally {
      bytes[40] ^= 0xff
      writeFileSync(asar, bytes)
      rmSync(iso, { recursive: true, force: true })
    }
  }
}

// ── 4. Verdict ───────────────────────────────────────────────────────────────────────
const pass = failures.length === 0
mkdirSync(join(ROOT, 'out'), { recursive: true })
writeFileSync(
  join(ROOT, 'out', 'fuses-result.json'),
  JSON.stringify({ pass, app: appPath, packagedHere, wall, tamper, platform: process.platform }, null, 2)
)

if (!pass) {
  console.error('\nFUSES: the packaged artifact does not carry the declared fuse wall.\n')
  for (const f of failures) console.error(`  ${f}`)
  console.error('\nThe wall lives in electron-builder.yml (`electronFuses`) and is asserted here — the two')
  console.error('must agree. RunAsNode is DISABLE since the runtime split (ADR 0017) — re-enabling it')
  console.error('re-opens the Node-interpreter hole; every change to the wall is a deliberate')
  console.error('ADR-0016/0016 decision, not a config tweak.\n')
  process.exit(1)
}

console.log(
  `  fuses OK — ${Object.keys(EXPECTED).length} fuse wall exact on ${appPath.replace(ROOT, '.')}` +
    (tamper.ran ? `; tampered asar refused to load in ${tamper.ms}ms` : '; tamper proof skipped (Linux does not enforce asar integrity)')
)
