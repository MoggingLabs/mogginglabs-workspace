#!/usr/bin/env node
// Build the in-repo device-key addon (src/backend/platform/device-key) — the
// TPM / Secure-Enclave key store behind the account's DPoP key (phase-accounts/06).
//
// It is pure Node-API (NAPI_VERSION=8), so the compiled .node is ABI-stable across
// Node and Electron — building against the LOCAL Node headers is sufficient, and an
// Electron major bump does not stale it. It still joins `npm run rebuild:native`
// (scripts/rebuild-native.mjs calls this with --force) so the one command everyone
// reaches for after a toolchain problem also rebuilds this addon, and it runs on
// postinstall so a fresh clone boots: src/main/native-preflight.ts dlopens the
// artifact and exits 1 when it is missing.
//
// Incremental by default: postinstall runs on every `npm install`, and a full
// node-gyp rebuild (clean + configure + compile) costs ~15s of MSVC spin-up for a
// no-op. Skip when the .node is newer than every source input; --force rebuilds.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'src', 'backend', 'platform', 'device-key')
const artifact = join(dir, 'build', 'Release', 'device_key.node')
const force = process.argv.includes('--force')

const inputs = [join(dir, 'binding.gyp'), ...readdirSync(join(dir, 'src')).map((f) => join(dir, 'src', f))]
const fresh = existsSync(artifact) && inputs.every((f) => statSync(f).mtimeMs <= statSync(artifact).mtimeMs)
if (fresh && !force) {
  console.log('  device-key addon up to date')
  process.exit(0)
}

// shell:true is load-bearing on Windows: npx is npx.cmd, and since the CVE-2024-27980
// fix Node refuses to execFile a .cmd without a shell (EINVAL).
console.log('  building device-key addon (node-gyp)...')
const { status, error } = spawnSync('npx node-gyp rebuild', { cwd: dir, stdio: 'inherit', shell: true })
if (error) {
  console.error(`\nCould not run node-gyp: ${error.message}\n`)
  process.exit(1)
}
if (status !== 0) process.exit(status ?? 1)

// Trust nothing: a "successful" build that produced no binary is the silent failure
// scripts/rebuild-native.mjs exists to kill — same law here.
if (!existsSync(artifact)) {
  console.error('\ndevice-key build reported success but produced no device_key.node\n')
  process.exit(1)
}
console.log('  device-key addon OK')
