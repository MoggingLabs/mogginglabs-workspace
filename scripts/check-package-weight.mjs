#!/usr/bin/env node
// The package-weight gate (docs/research/2026-07-installer-ux-audit.md §8).
//
//   node scripts/check-package-weight.mjs                  # verify dist/<platform>-unpacked
//   MOGGING_WEIGHT_APP=<dir> node scripts/check-package-weight.mjs
//
// THE RULE: build debris does not ship.
//
// v0.16.0 put 618MB across 1143 files in front of every user. 137MB and 916 of those files
// were MSVC link intermediates, MSBuild .tlog logs, two copies of a 9.5MB sqlite3.c, 57MB of
// .pdb debug symbols, prebuilt binaries for three architectures the installer cannot run on,
// and prebuild-install's own 36-package download tree. None of it is loaded by any process.
//
// It cost more than download size. electron-builder's NSIS section writes the payload to
// %TEMP%, decompresses it there, and THEN copies it to the install directory
// (templates/nsis/include/extractAppPackage.nsh:73-108) — so every byte lands twice and is
// scanned by Defender twice, and every FILE pays per-file syscall and scanner dispatch on
// both passes. On this payload the file count mattered more than the bytes.
//
// WHY A GATE AND NOT JUST A FIX: debris regrows. It arrives silently with the next
// `buildDependenciesFromSource` compile, the next node-pty bump that adds a platform to
// prebuilds/, the next transitive dep that vendors its own sources. The prune rules live in
// electron-builder.yml (`files:` negations, Electron-ABI copies) and
// scripts/prune-helper-deps.mjs (the standalone helper's tree); this asserts they still bite.
//
// The thresholds are ceilings with headroom, not targets — they exist to catch a REGRESSION
// (a tree that has doubled), not to police a few MB. Raise them deliberately, with a note
// saying what grew and why.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const UNPACKED = {
  win32: 'dist/win-unpacked',
  darwin: 'dist/mac-arm64',
  linux: 'dist/linux-unpacked'
}[process.platform]

const appDir = process.env.MOGGING_WEIGHT_APP ?? join(ROOT, UNPACKED ?? 'dist')
if (!existsSync(appDir)) {
  console.error(`\nWEIGHT: nothing to weigh at ${appDir}.`)
  console.error('Run a package first (npm run dist:win / dist:mac), or point MOGGING_WEIGHT_APP at one.\n')
  process.exit(1)
}

// Ceilings for the WHOLE unpacked tree. Post-prune the win/linux tree measures ~481MB /
// ~210 files; Electron itself is ~330MB of that and the pinned Node helper another 88MB,
// so the floor is high and the movement to watch for is in the hundreds of files, not the
// tens. macOS gets its own ceiling: the first mac weigh-in (2026-08-01, run 30710089843)
// measured 593MB with ZERO forbidden shapes — Electron.app's framework and the darwin
// Node helper are simply bigger — so 620 keeps the same ~5% headroom the others have.
// The ceiling is only the backstop; the FORBIDDEN scan below is the diagnostic, and it
// stays platform-blind on purpose.
const MAX_MB = process.platform === 'darwin' ? 620 : 560
const MAX_FILES = 400

// Extensions and paths that must never appear in a shipped tree, with the reason each one is
// dead. A hit here is the actual diagnostic — the size ceiling is only the backstop that
// catches a shape nobody predicted.
const FORBIDDEN = [
  { test: (p) => /\.(iobj|ipdb|ilk|exp)$/i.test(p), why: 'MSVC incremental-link intermediate' },
  { test: (p) => /\.lib$/i.test(p), why: 'static/import library — link-time only' },
  { test: (p) => /\.pdb$/i.test(p), why: 'debug symbols' },
  { test: (p) => /[\\/][^\\/]+\.tlog[\\/]/i.test(p), why: 'MSBuild log' },
  { test: (p) => /[\\/]build[\\/].*[\\/]obj([\\/.]|$)/i.test(p), why: 'node-gyp intermediate object tree' },
  { test: (p) => /\.(vcxproj|filters|recipe|sln)$/i.test(p), why: 'MSVC project/MSBuild stamp — a build input' },
  { test: (p) => /\.(gyp|gypi)$/i.test(p), why: 'node-gyp build definition' },
  // extraResources bypasses electron-builder.yml's global `!**/*.map`, so the helper tree is
  // the one that quietly keeps sourcemaps. Catch them wherever they are.
  { test: (p) => /\.map$/i.test(p), why: 'sourcemap' },
  { test: (p) => /[\\/]sqlite3\.c$/i.test(p), why: 'sqlite3 amalgamation source — compile-time only' },
  { test: (p) => /[\\/]node_modules[\\/]prebuild-install[\\/]/i.test(p), why: "prebuild-install — the natives are already on disk" },
  { test: (p) => /[\\/]node-addon-api[\\/]/i.test(p), why: 'C++ headers for node-gyp' },
  { test: (p) => /[\\/]test_extension\.node$/i.test(p), why: "better-sqlite3's sqlite test fixture — not a Node addon" },
  { test: (p) => /\.test\.js$/i.test(p), why: 'package test file' }
]

// node-pty ships one prebuilds/ directory per platform-arch. Only this build's may survive —
// the rest are binaries that cannot execute on the machine that just ran the installer.
const HOST_TRIPLE = `${process.platform}-${process.arch}`
FORBIDDEN.push({
  test: (p) => {
    const m = /[\\/]prebuilds[\\/]([^\\/]+)[\\/]/i.exec(p)
    return m != null && m[1].toLowerCase() !== HOST_TRIPLE.toLowerCase()
  },
  why: `prebuilt binary for a foreign architecture (this build is ${HOST_TRIPLE})`
})

let bytes = 0
let files = 0
const offenders = []
const stack = [appDir]
while (stack.length) {
  const dir = stack.pop()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      stack.push(p)
      continue
    }
    files++
    const size = statSync(p).size
    bytes += size
    const rel = p.slice(appDir.length)
    const hit = FORBIDDEN.find((f) => f.test(rel))
    if (hit) offenders.push({ rel, mb: size / 1048576, why: hit.why })
  }
}

const mb = bytes / 1048576
const failures = []
if (offenders.length) failures.push(`${offenders.length} forbidden file(s)`)
if (mb > MAX_MB) failures.push(`tree is ${mb.toFixed(0)}MB, ceiling is ${MAX_MB}MB`)
if (files > MAX_FILES) failures.push(`tree holds ${files} files, ceiling is ${MAX_FILES}`)

if (failures.length) {
  console.error(`\nWEIGHT: build debris is in the package (${appDir.replace(ROOT, '.')}).\n`)
  for (const f of failures) console.error(`  ${f}`)
  if (offenders.length) {
    console.error('')
    const worst = offenders.sort((a, b) => b.mb - a.mb).slice(0, 25)
    for (const o of worst) console.error(`  ${o.mb.toFixed(2).padStart(8)}MB  ${o.rel}   (${o.why})`)
    if (offenders.length > worst.length) console.error(`  … and ${offenders.length - worst.length} more`)
    const total = offenders.reduce((a, o) => a + o.mb, 0)
    console.error(`\n  ${total.toFixed(1)}MB of dead weight across ${offenders.length} files.`)
  }
  console.error('\nThe prune rules are electron-builder.yml (`files:` negations) for the Electron-ABI')
  console.error('copies and scripts/prune-helper-deps.mjs for resources/node-helper. Add the new shape')
  console.error('to whichever applies — and remember every file here is written TWICE during install')
  console.error('and scanned twice (audit §2), so this is install time, not just download size.\n')
  process.exit(1)
}

console.log(`  weight OK — ${mb.toFixed(0)}MB / ${files} files, no build debris (${appDir.replace(ROOT, '.')})`)
