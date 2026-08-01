#!/usr/bin/env node
// The ConPTY-pin gate.
//
//   node scripts/check-conpty-pin.mjs
//
// THE RULE: every staged conpty.dll/OpenConsole.exe byte-matches the VENDORED pair
// (build/conpty/<pin>/), and the pin named here matches build-node-helper.mjs.
//
// pty-host.ts spawns with useConptyDll, so the staged pair IS the terminal backend every
// Windows pane runs. npm restages the tarball's own (older) pair on every install, and
// build-node-helper's overlay is what puts the pinned one back — a missed overlay is a
// silent downgrade to a backend with known resize bugs, visible only as artifact reports
// months later. Byte-compare (the mcp-catalog.json precedent): no version-resource
// parsing, no trust in filenames.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const helperSrc = readFileSync(join(ROOT, 'scripts', 'build-node-helper.mjs'), 'utf8')
const pinMatch = /const CONPTY_PIN = '([0-9.]+)'/.exec(helperSrc)
if (!pinMatch) {
  console.error('\nCONPTY PIN: build-node-helper.mjs no longer declares CONPTY_PIN — the overlay is gone.\n')
  process.exit(1)
}
const PIN = pinMatch[1]

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const FILES = ['conpty.dll', 'OpenConsole.exe']
const ARCHES = ['x64', 'arm64']

let checked = 0
let failed = 0
for (const arch of ARCHES) {
  const vendor = join(ROOT, 'build', 'conpty', PIN, `win10-${arch}`)
  if (!existsSync(vendor)) {
    console.error(`\nCONPTY PIN: vendored pair missing for ${arch}: ${vendor}\n`)
    process.exit(1)
  }
  const want = Object.fromEntries(FILES.map((f) => [f, sha(join(vendor, f))]))
  // Every place a staged pair can live. Absent trees pass (a linux checkout stages no
  // Windows helper); PRESENT trees must match.
  const trees = [
    join(ROOT, 'build', 'node-helper', `win32-${arch}`, 'node_deps', 'node-pty', 'prebuilds', `win32-${arch}`, 'conpty'),
    join(ROOT, 'build', 'node-helper', `win32-${arch}`, 'node_deps', 'node-pty', 'build', 'Release', 'conpty'),
    ...(arch === (process.arch === 'arm64' ? 'arm64' : 'x64')
      ? [
          join(ROOT, 'node_modules', 'node-pty', 'prebuilds', `win32-${arch}`, 'conpty'),
          join(ROOT, 'node_modules', 'node-pty', 'build', 'Release', 'conpty')
        ]
      : [])
  ]
  for (const dir of trees) {
    if (!existsSync(dir)) continue
    for (const f of FILES) {
      const p = join(dir, f)
      if (!existsSync(p)) continue
      checked++
      if (sha(p) !== want[f]) {
        failed++
        console.error(`  MISMATCH ${p} (not the pinned ${PIN} bytes)`)
      }
    }
  }
}

if (failed) {
  console.error(
    `\nCONPTY PIN: ${failed} staged file(s) do not match the vendored ${PIN} pair.` +
      '\nRun `node scripts/build-node-helper.mjs` (postinstall does) to re-overlay.\n'
  )
  process.exit(1)
}
console.log(`  conpty pin OK — ${checked} staged file(s) byte-match vendored ${PIN}`)
