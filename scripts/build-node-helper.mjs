#!/usr/bin/env node
// The standalone Node helper build (ADR 0017 — the runtime split).
//
//   node scripts/build-node-helper.mjs            # build for THIS platform+arch
//   MOGGING_HELPER_FORCE=1 node scripts/…         # rebuild even when the stamp matches
//
// WHAT IT PRODUCES: build/node-helper/<platform>-<arch>/
//   mogging-node[.exe]     a pinned official Node runtime, renamed — the host for the
//                          detached PTY daemon, the house MCP server and every `mogging`
//                          CLI shim once the Electron binary drops the RunAsNode fuse
//   node_modules/          node-pty + better-sqlite3 (and their runtime deps) installed
//                          for the HELPER's ABI — the app's own node_modules natives are
//                          compiled against Electron's ABI and must never load here
//   .helper-stamp.json     what was built, so postinstall can skip when nothing changed
//
// WHY A NAKED PINNED BINARY AND NOT AN SEA/pkg BUNDLE: the helper must execute the
// daemon entry, the versioned CLI satellites, and MCP launcher scripts that persist in
// CLI config files across releases — arbitrary on-disk script paths, by design (the
// stable-launcher architecture in cli-runtime.ts). An SEA whose bootstrap `import()`s
// argv[1] is byte-for-byte as capable as the naked binary, so the naked binary is the
// smaller, more debuggable choice. The security claim never rested on restricting the
// helper — it rests on the SIGNED, Keychain-entitled Electron binary no longer being a
// Node interpreter (ADR 0017 states the residual: the helper is a smaller, GUI-less,
// no-Keychain-entitlement target, covered by the bundle signature like the rest of the
// asarUnpack set).
//
// THE PIN. One exact Node version everywhere, LTS line 24 (N-API/SEA-era, matches the
// dev machines). When the building machine's own node IS the pinned version, its binary
// is copied (offline, deterministic); otherwise the official dist archive is downloaded
// over TLS and verified against the SHASUMS256.txt of the same release before a byte of
// it is trusted. CI runs node 22, so CI downloads; dev machines on 24.15.0 copy.
//
// NATIVES. npm installs the two packages into the helper dir with npm_config_runtime/
// target pinned to the helper's version — prebuilt N-API binaries where the package
// ships them (node-pty), prebuild-install or a source build where it does not
// (better-sqlite3; the toolchain exists on every machine that can build the app). The
// result is PROBED before the stamp is written: the helper binary itself must load both
// addons and round-trip a real pty spawn + a real sqlite insert, or this build fails —
// a helper that cannot host the daemon must never reach a gate, let alone a package.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const HELPER_NODE_VERSION = '24.15.0'
const NODE_DIST = `https://nodejs.org/dist/v${HELPER_NODE_VERSION}`

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM = process.platform
const ARCH = process.arch
const OUT = join(ROOT, 'build', 'node-helper', `${PLATFORM}-${ARCH}`)
const EXE = PLATFORM === 'win32' ? 'mogging-node.exe' : 'mogging-node'
// electron-builder STRIPS any `node_modules` path segment from an extraResources copy
// (hardcoded, not a filter). So the helper's deps ship under a differently-named dir
// (`node_deps`) that survives packaging, and the daemon reaches them via NODE_PATH +
// explicit resolution (@backend/platform/native-require, MOGGING_HELPER_NATIVES). This
// name is the ONE source of truth — node-helper.ts and native-require read the env var,
// never this constant, but the layout must match.
export const HELPER_DEPS_DIR = 'node_deps'
// The stamp lives OUTSIDE OUT, next to it — electron-builder copies the whole OUT
// directory, so nothing extraneous may sit inside it.
const STAMP = join(ROOT, 'build', 'node-helper', `${PLATFORM}-${ARCH}.stamp.json`)

// The two natives the daemon actually requires at runtime (out/main/daemon.js's only
// non-builtin externals). Versions come from the INSTALLED packages, never a range —
// the helper must carry exactly what the app was built against.
const NATIVE_DEPS = ['node-pty', 'better-sqlite3']
const depVersions = Object.fromEntries(
  NATIVE_DEPS.map((name) => [name, JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version])
)

const wanted = { node: HELPER_NODE_VERSION, platform: PLATFORM, arch: ARCH, deps: depVersions }

if (!process.env.MOGGING_HELPER_FORCE) {
  try {
    const have = JSON.parse(readFileSync(STAMP, 'utf8'))
    if (JSON.stringify(have) === JSON.stringify(wanted) && existsSync(join(OUT, EXE)) && existsSync(join(OUT, HELPER_DEPS_DIR))) {
      console.log(`  node helper OK — v${HELPER_NODE_VERSION} ${PLATFORM}-${ARCH} already built (stamp matches)`)
      process.exit(0)
    }
  } catch {
    /* no stamp — build */
  }
}

mkdirSync(OUT, { recursive: true })
rmSync(STAMP, { force: true }) // a half-finished build must never pass the stamp check

// ── 1. The pinned Node binary ─────────────────────────────────────────────────────────
const helperBin = join(OUT, EXE)

const download = async (url) => {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function fetchPinnedNode() {
  const archiveName =
    PLATFORM === 'win32'
      ? `node-v${HELPER_NODE_VERSION}-win-${ARCH}.zip`
      : `node-v${HELPER_NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz`
  console.log(`  downloading ${NODE_DIST}/${archiveName} …`)
  const [archive, sums] = await Promise.all([
    download(`${NODE_DIST}/${archiveName}`),
    download(`${NODE_DIST}/SHASUMS256.txt`)
  ])
  const line = sums
    .toString('utf8')
    .split('\n')
    .find((l) => l.trim().endsWith(archiveName))
  const want = line?.trim().split(/\s+/)[0]
  if (!want) throw new Error(`SHASUMS256.txt has no entry for ${archiveName}`)
  const got = createHash('sha256').update(archive).digest('hex')
  if (got !== want) throw new Error(`${archiveName}: sha256 mismatch (got ${got}, want ${want})`)

  const scratch = join(tmpdir(), `mogging-helper-${process.pid}`)
  mkdirSync(scratch, { recursive: true })
  try {
    const archivePath = join(scratch, archiveName)
    writeFileSync(archivePath, archive)
    const inner = `node-v${HELPER_NODE_VERSION}-${PLATFORM === 'win32' ? `win-${ARCH}` : `${PLATFORM}-${ARCH}`}`
    if (PLATFORM === 'win32') {
      const r = spawnSync('tar', ['-xf', archivePath, `${inner}/node.exe`], { cwd: scratch, stdio: 'inherit' })
      if (r.status !== 0) throw new Error('archive extraction failed')
      copyFileSync(join(scratch, inner, 'node.exe'), helperBin)
    } else {
      const r = spawnSync('tar', ['-xzf', archivePath, `${inner}/bin/node`], { cwd: scratch, stdio: 'inherit' })
      if (r.status !== 0) throw new Error('archive extraction failed')
      copyFileSync(join(scratch, inner, 'bin', 'node'), helperBin)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.versions.node === HELPER_NODE_VERSION && !process.versions.electron) {
  // The machine's own node IS the pin: copy it. Offline, byte-identical to the dist binary.
  copyFileSync(process.execPath, helperBin)
  console.log(`  copied local node v${HELPER_NODE_VERSION} -> ${EXE}`)
} else {
  await fetchPinnedNode()
}
if (PLATFORM !== 'win32') chmodSync(helperBin, 0o755)

// ── 2. Helper-ABI natives ─────────────────────────────────────────────────────────────
// A private package.json in the helper dir keeps npm from walking up into the repo's;
// npm_config_runtime/target aim node-gyp and prebuild-install at the HELPER's Node even
// when the building machine runs a different one (CI is on 22).
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'mogging-node-helper-natives',
      private: true,
      description: 'Natives for the standalone helper runtime (ADR 0017) — built for ITS ABI, not Electron`s',
      dependencies: Object.fromEntries(NATIVE_DEPS.map((name) => [name, depVersions[name]]))
    },
    null,
    2
  ) + '\n'
)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // leaks from Electron-based host terminals; breaks child node spawns
// Windows: node-pty's source build spawns tooling that dies under this inherited var
// (see scripts/rebuild-native.mjs — same trap, same fix).
delete env.NoDefaultCurrentDirectoryInExePath
env.npm_config_runtime = 'node'
env.npm_config_target = HELPER_NODE_VERSION
env.npm_config_arch = ARCH
env.npm_config_target_arch = ARCH

console.log(`  installing helper natives (${NATIVE_DEPS.map((d) => `${d}@${depVersions[d]}`).join(', ')}) …`)
const NPM_ARGS = ['install', '--no-audit', '--no-fund', '--no-package-lock', '--omit=dev']
// One command STRING under a Windows shell (npm is npm.cmd): shell:true + an args array
// concatenates unescaped (DEP0190). None of these tokens needs quoting.
const npm =
  PLATFORM === 'win32'
    ? spawnSync(`npm ${NPM_ARGS.join(' ')}`, { cwd: OUT, env, stdio: 'inherit', shell: true })
    : spawnSync('npm', NPM_ARGS, { cwd: OUT, env, stdio: 'inherit' })
if (npm.status !== 0) {
  console.error('\nnode-helper: npm install of the helper natives failed — the helper cannot host the daemon.\n')
  process.exit(1)
}

// Rename node_modules → node_deps so electron-builder's node_modules-stripping never sees
// it (see HELPER_DEPS_DIR). npm flattens all deps to the top level of node_modules, so a
// bare `require('bindings')` inside better-sqlite3 resolves via NODE_PATH=<deps> — which
// the daemon spawn sets — while node-pty/better-sqlite3 themselves load by explicit path.
const depsDir = join(OUT, HELPER_DEPS_DIR)
rmSync(depsDir, { recursive: true, force: true })
renameSync(join(OUT, 'node_modules'), depsDir)

// ── 3. Prove it: the helper itself must load both addons and do real work ─────────────
// A pty spawn (node-pty) and an insert/select round-trip (better-sqlite3), executed BY
// the helper binary — not by this script's node. This is the same claim SURVIVE and
// RUNTIMESPLIT later make against the live daemon, made cheap and local so a broken
// helper dies HERE, with a stack, instead of as a red gate an hour later.
// The probe loads EXACTLY as the daemon will (native-require): explicit absolute paths
// for the two packages, NODE_PATH (set below) for their transitive bare deps.
const PROBE = String.raw`
const { createRequire } = require('node:module')
const path = require('node:path')
const deps = process.argv[2]
const req = createRequire(path.join(deps, 'anchor.js'))
const results = {}
const pty = req(path.join(deps, 'node-pty'))
const Database = req(path.join(deps, 'better-sqlite3'))
const db = new Database(':memory:')
db.exec('CREATE TABLE t (v TEXT)')
db.prepare('INSERT INTO t (v) VALUES (?)').run('helper-ok')
results.sqlite = db.prepare('SELECT v FROM t').get().v
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
const p = pty.spawn(shell, process.platform === 'win32' ? ['/c', 'echo HELPER_PTY_OK'] : ['-c', 'echo HELPER_PTY_OK'], { cols: 80, rows: 24 })
let out = ''
p.onData((d) => { out += d })
p.onExit(() => {
  results.pty = out.includes('HELPER_PTY_OK')
  console.log(JSON.stringify(results))
  process.exit(results.pty && results.sqlite === 'helper-ok' ? 0 : 1)
})
setTimeout(() => { console.error('probe timeout; got: ' + JSON.stringify(out)); process.exit(1) }, 15000)
`
const probePath = join(OUT, '.probe.cjs')
writeFileSync(probePath, PROBE)
const probe = spawnSync(helperBin, [probePath, depsDir], {
  env: { ...env, NODE_PATH: depsDir + (env.NODE_PATH ? delimiter + env.NODE_PATH : '') },
  encoding: 'utf8',
  timeout: 30000,
  windowsHide: true
})
rmSync(probePath, { force: true })
if (probe.status !== 0) {
  console.error(`\nnode-helper: the load probe FAILED under ${EXE} (exit ${probe.status ?? probe.signal}).`)
  console.error(`${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim().slice(0, 2000))
  console.error('\nThe helper cannot host the daemon — nothing was stamped; fix the native build and re-run.\n')
  process.exit(1)
}
console.log(`  probe OK under ${EXE}: ${String(probe.stdout).trim()}`)

// Stamp LAST: its existence asserts everything above succeeded.
writeFileSync(STAMP, JSON.stringify(wanted))
console.log(`  node helper OK — v${HELPER_NODE_VERSION} ${PLATFORM}-${ARCH} at build/node-helper/${PLATFORM}-${ARCH}/${EXE}`)
