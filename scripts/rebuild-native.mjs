#!/usr/bin/env node
// Rebuild the native modules against the INSTALLED Electron's ABI.
//
// WHY THIS EXISTS. `npm run postinstall` (electron-builder install-app-deps) is the real
// rebuild, but it cannot be run twice on a dirty tree: node-gyp's msvs generator finishes with
// `os.rename(tmp, 'binding.sln')`, and Windows rename refuses an existing destination. So the
// FIRST thing an Electron-major bump does is fail with
//
//     FileExistsError: [WinError 183] Cannot create a file when that file already exists:
//       ...better-sqlite3\build\binding.sln.gyp.<rand>.tmp -> ...better-sqlite3\build\binding.sln
//
// which reads like a bug and is really just a stale build/ from the previous ABI. Clear it, then
// rebuild. Nothing here is recoverable at runtime — see src/main/fatal.ts, which points users
// back at this script when a .node loads with the wrong NODE_MODULE_VERSION.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Every dependency with a binding.gyp. Both compile from source against Electron's ABI — that is
// `buildDependenciesFromSource: true` in electron-builder.yml, which the install-app-deps call at
// the bottom of this script honours. It never came from .npmrc (that file is gone: npm never
// supported its `build_from_source` key — see scripts/check-npm-config.mjs).
const NATIVE = ['better-sqlite3', 'node-pty']

const repo = process.cwd()
const isWin = process.platform === 'win32'

/**
 * node-pty/binding.gyp sets `'SpectreMitigation': 'Spectre'` unconditionally, so the Spectre-
 * mitigated MSVC runtime is a HARD requirement on Windows — the VCTools workload alone does not
 * install it. Without this preflight the failure lands as MSB8040 after a multi-minute compile.
 */
function assertSpectreLibs() {
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  )
  if (!existsSync(vswhere)) return // no VS at all: let node-gyp produce its own toolchain error
  let installPath
  try {
    installPath = execFileSync(vswhere, ['-products', '*', '-property', 'installationPath', '-latest'], {
      encoding: 'utf8'
    }).trim()
  } catch {
    return
  }
  const msvc = join(installPath, 'VC', 'Tools', 'MSVC')
  if (!installPath || !existsSync(msvc)) return
  const hasSpectre = readdirSync(msvc).some((v) => existsSync(join(msvc, v, 'lib', 'spectre')))
  if (hasSpectre) return
  const installer = join(installPath, '..', '..', 'Installer', 'vs_installer.exe')
  console.error(
    '\nMissing: MSVC Spectre-mitigated libraries (node-pty requires them; MSB8040).\n' +
      'Run this in an ELEVATED PowerShell, then re-run this script:\n\n' +
      `    & "${installer}" modify --installPath "${installPath}" ` +
      '--add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --quiet --norestart\n'
  )
  process.exit(1)
}

if (isWin) assertSpectreLibs()

for (const mod of NATIVE) {
  const build = join(repo, 'node_modules', mod, 'build')
  if (!existsSync(build)) continue
  // A live app holds an open handle to build/Release/*.node; EBUSY here means "close the app",
  // not "the tree is corrupt". Say which.
  try {
    rmSync(build, { recursive: true, force: true })
    console.log(`  cleared ${mod}/build`)
  } catch (err) {
    console.error(
      `\nCould not remove ${mod}/build (${err.code ?? err.message}).\n` +
        'A running app or dev server still has the .node open. Stop it (npm run kill-devservers) and retry.\n'
    )
    process.exit(1)
  }
}

// The rebuild itself. Reads electronVersion from the installed electron + electron-builder.yml.
// shell:true is load-bearing on Windows: npx is npx.cmd, and since the CVE-2024-27980 fix Node
// refuses to execFile a .cmd without a shell (EINVAL) — which would fail here with no output.
console.log('  rebuilding against the installed Electron ABI...')
const { status, error } = spawnSync('npx electron-builder install-app-deps', { stdio: 'inherit', shell: true })
if (error) {
  console.error(`\nCould not run electron-builder: ${error.message}\n`)
  process.exit(1)
}
if (status !== 0) process.exit(status ?? 1) // electron-builder already printed the compiler's diagnostics

// Trust nothing: a "successful" rebuild that produced no binary is the exact silent failure this
// whole change exists to kill.
const missing = NATIVE.filter((m) => {
  const rel = join(repo, 'node_modules', m, 'build', 'Release')
  return !existsSync(rel) || !readdirSync(rel).some((f) => f.endsWith('.node'))
})
if (missing.length) {
  console.error(`\nRebuild reported success but produced no .node for: ${missing.join(', ')}\n`)
  process.exit(1)
}
console.log('  native modules OK')
