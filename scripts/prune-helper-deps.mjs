// The helper's ship-list (docs/research/2026-07-installer-ux-audit.md §3b).
//
// `npm install` produces a DEVELOPMENT tree. build-node-helper.mjs renames that tree to
// node_deps and electron-builder copies it verbatim into the installer, so v0.16.0 shipped
// all 78MB / 696 files of it to every user — for a set of runtime files that weighs ~5MB.
//
// It lives in its own module for one reason: it is the only part of the helper build that
// DELETES things, so it has to be runnable — and provable — against a throwaway copy of a
// real tree without downloading a Node runtime or running npm. See the probe note below.
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// An ALLOW-list, not a deny-list, and deliberately so: npm flattens ~40 packages in here
// and only these four are reachable at runtime. A deny-list written by eye would have taken
// `bindings` with it — better-sqlite3's lib/database.js does
// `require('bindings')('better_sqlite3.node')`, resolved through the NODE_PATH the daemon
// spawn sets — and the failure mode would have been a packaged app that cannot open its
// session store at all. The rest is prebuild-install's download tree (tar-fs, simple-get,
// node-abi, rc, semver, …), which has no job left once the natives are on disk.
//
// TO REGENERATE after a dependency bump: take every non-builtin `require()` inside the two
// native packages and close over it transitively. Today that is
//   node-pty        → nothing. Its lone bare require is `ps-list`, in
//                     lib/windowsTerminal.test.js — a devDependency that is not installed.
//   better-sqlite3  → bindings → file-uri-to-path
export const HELPER_RUNTIME_DEPS = ['node-pty', 'better-sqlite3', 'bindings', 'file-uri-to-path']

// Link intermediates, debug symbols, node-gyp's generated MSVC project files, and — the one
// this tree needs and the app.asar side does not — SOURCEMAPS. electron-builder.yml's global
// `!**/*.map` covers `files:`, but this directory ships through `extraResources`, which that
// negation never sees; v0.16.0 shipped 18 .js.map files here, half of them for test files.
// Kept deliberately in step with the extension set electron-builder.yml applies to the
// Electron-ABI copies, so the two trees do not drift apart.
const DEAD_EXT = /\.(pdb|iobj|ipdb|ilk|exp|lib|map|vcxproj|filters|recipe|sln|gyp|gypi)$/i

// Package metadata and CI config that npm ships and nothing reads. LICENSE files STAY —
// they are a redistribution obligation, not clutter.
const DEAD_NAME = new Set(['.npmignore', '.travis.yml', '.editorconfig', '.eslintrc', 'History.md', 'README.md', 'CHANGELOG.md', '.gitattributes'])

/**
 * Strip a built helper deps dir down to what actually runs. Idempotent: a second pass over
 * an already-pruned tree deletes nothing.
 *
 * NOT SAFE BY ASSERTION — SAFE BY PROOF. build-node-helper.mjs calls this BEFORE its load
 * probe, and that probe drives the helper binary through a real pty spawn and a real sqlite
 * insert/select. Take something load-bearing and the build exits non-zero with a stack: no
 * stamp is written, so no package can be produced and nothing reaches a user.
 *
 * @param {string} depsDir  the renamed node_deps directory
 * @param {string} hostTriple  `${process.platform}-${process.arch}` of the target
 * @returns {{ removed: string[] }}
 */
export function pruneHelperDeps(depsDir, hostTriple) {
  const removed = []
  const drop = (p, label) => {
    if (!existsSync(p)) return
    rmSync(p, { recursive: true, force: true })
    removed.push(label)
  }

  // 1. Everything npm flattened in that nothing requires.
  const keep = new Set(HELPER_RUNTIME_DEPS)
  for (const entry of readdirSync(depsDir)) {
    if (!keep.has(entry)) drop(join(depsDir, entry), entry)
  }

  // 2. node-pty ships win32-x64, win32-arm64, darwin-x64 and darwin-arm64 prebuilds. Three
  //    of the four cannot execute on the machine this build targets. Keyed on the HOST
  //    triple so every platform's helper keeps exactly its own — and note this tree, unlike
  //    the Electron-ABI copy, LOADS from prebuilds/ (npm fetched binaries; there is no
  //    source build to fill build/Release), so the host's own directory is untouchable.
  const prebuilds = join(depsDir, 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (entry !== hostTriple) drop(join(prebuilds, entry), `node-pty/prebuilds/${entry}`)
    }
  }

  // 3. Compile inputs and build tooling. better-sqlite3's deps/sqlite3/sqlite3.c alone is
  //    9.5MB of C; better_sqlite3.node is the artifact and stays in build/Release.
  for (const rel of [
    ['node-pty', 'third_party'],
    ['node-pty', 'deps'],
    ['node-pty', 'src'],
    ['node-pty', 'scripts'],
    ['better-sqlite3', 'deps'],
    ['better-sqlite3', 'src']
  ]) {
    drop(join(depsDir, ...rel), rel.join('/'))
  }

  // 4. Symbols, intermediates, MSBuild logs and test files, wherever they landed. In
  //    prebuilds/win32-x64 this is 28.6MB of .pdb against 1.3MB of actual binaries.
  const stack = [depsDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.tlog')) drop(p, entry.name)
        else stack.push(p)
      } else if (DEAD_EXT.test(entry.name) || DEAD_NAME.has(entry.name) || entry.name.endsWith('.test.js')) {
        drop(p, entry.name)
      }
    }
  }

  return { removed }
}
