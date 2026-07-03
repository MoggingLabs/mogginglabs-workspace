#!/usr/bin/env node
// Signing/notarization readiness verifier (Phase-6/02). Runs on windows + macos
// CI right after an UNSIGNED package build and answers one question: the day
// certificates arrive, is a signed release a SECRETS-ONLY change?
//
//   - CONFIG checks (entitlements, hardened runtime, identity plumbing in the
//     release workflow, packaged artifacts) are BLOCKERS -> exit 1.
//   - SECRETS are reported as present/absent booleans ONLY — values never touch
//     stdout, and their absence is the expected dry-run state (ADR 0002: no
//     credentials in this repo, ours included).
//
// Verdict line (the DoD string): SIGNING DRYRUN: READY (config-complete, secrets-pending: ...)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const mac = process.platform === 'darwin'
const blockers = []
const notes = []

const check = (ok, what) => {
  console.log(`  ${ok ? 'ok' : 'BLOCKER'}  ${what}`)
  if (!ok) blockers.push(what)
}

const builderYml = existsSync('electron-builder.yml') ? readFileSync('electron-builder.yml', 'utf8') : ''
const releaseYml = existsSync('.github/workflows/release.yml')
  ? readFileSync('.github/workflows/release.yml', 'utf8')
  : ''
const distFiles = existsSync('dist') ? readdirSync('dist') : []

console.log(`── signing readiness (${process.platform}) ──`)

// ── Shared config: the release workflow must already plumb every secret ──────
check(builderYml.includes('provider: github'), 'electron-builder.yml publishes to the GitHub feed')
for (const env of ['CSC_LINK', 'CSC_KEY_PASSWORD']) {
  check(releaseYml.includes(env), `release.yml plumbs ${env} into packaging`)
}
check(
  releaseYml.includes('CSC_IDENTITY_AUTO_DISCOVERY'),
  'release.yml has the identity-discovery switch (flip when certs land)'
)

if (mac) {
  // ── macOS: entitlements + hardened runtime + notarization config ───────────
  const plistPath = 'build/entitlements.mac.plist'
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : ''
  check(plist !== '', `${plistPath} exists`)
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation', // from-source native modules
    'com.apple.security.cs.allow-dyld-environment-variables' // ELECTRON_RUN_AS_NODE daemon
  ]) {
    check(plist.includes(key), `entitlements grant ${key.split('.').pop()}`)
  }
  check(builderYml.includes('hardenedRuntime: true'), 'hardened runtime enabled (notarization requires it)')
  check(builderYml.includes(`entitlements: ${plistPath}`), 'entitlements wired into the mac build')
  check(builderYml.includes(`entitlementsInherit: ${plistPath}`), 'child-process entitlements wired in')
  check(builderYml.includes('notarize: true'), 'notarization enabled (runs when APPLE_* secrets exist)')
  for (const env of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    check(releaseYml.includes(env), `release.yml plumbs ${env} for notarytool`)
  }

  check(distFiles.some((f) => f.endsWith('.dmg')), 'dmg packaged (cask + human installs)')
  check(distFiles.some((f) => f.endsWith('.zip')), 'zip packaged (electron-updater feed needs it)')

  // Ground truth from codesign: the UNSIGNED build must still be a coherent
  // bundle (adhoc/linker-signed on arm64) — a signed build just swaps identity.
  const macDir = distFiles.find((d) => /^mac/.test(d))
  const appName = macDir ? readdirSync(join('dist', macDir)).find((f) => f.endsWith('.app')) : undefined
  if (macDir && appName) {
    try {
      const out = execFileSync('codesign', ['-dv', join('dist', macDir, appName)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      notes.push(`codesign: ${out.split('\n').find((l) => l.includes('Signature')) || 'no signature line'}`)
    } catch (e) {
      // codesign -dv writes to stderr even on success; unsigned x64 reports "not signed at all".
      const msg = String(e.stderr || e.message)
      notes.push(
        `codesign: ${(msg.split('\n').find((l) => l.includes('Signature') || l.includes('not signed')) || msg.split('\n')[0]).trim()}`
      )
    }
  } else {
    check(false, 'packaged .app found under dist/mac*/')
  }
} else {
  // ── Windows: Authenticode target + artifacts ────────────────────────────────
  check(builderYml.includes('nsis'), 'NSIS installer target configured')
  const exe = distFiles.find((f) => f.endsWith('.exe'))
  check(!!exe, 'NSIS exe packaged')
  check(distFiles.some((f) => f.endsWith('.exe.blockmap')), 'blockmap packaged (differential updates)')
  if (exe) {
    try {
      const status = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-AuthenticodeSignature 'dist/${exe}').Status`],
        { encoding: 'utf8' }
      ).trim()
      notes.push(`Authenticode status: ${status} (NotSigned is the expected dry-run state)`)
    } catch {
      notes.push('Authenticode status: unavailable (Get-AuthenticodeSignature failed)')
    }
  }
}

// ── Secrets: booleans only. Absence is EXPECTED here, presence means CI is
// already configured — either way the config above is what this job certifies.
const secretNames = mac
  ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  : ['CSC_LINK', 'CSC_KEY_PASSWORD']
const pending = secretNames.filter((n) => !process.env[n])
for (const n of secretNames) console.log(`  secret ${n}: ${process.env[n] ? 'present' : 'pending'}`)
for (const n of notes) console.log(`  note: ${n}`)

if (blockers.length) {
  console.error(`\nSIGNING DRYRUN: BLOCKED — ${blockers.length} config gap(s):`)
  for (const b of blockers) console.error(`  - ${b}`)
  process.exit(1)
}
console.log(
  `\nSIGNING DRYRUN: READY (config-complete, ${pending.length ? `secrets-pending: ${pending.join(', ')}` : 'secrets-present'})`
)
