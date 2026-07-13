#!/usr/bin/env node
// The npm-config gate (audit finding 42).
//
//   node scripts/check-npm-config.mjs
//
// THE RULE: `npm install` emits no config warnings, and a root .npmrc carries no key npm
// does not support.
//
// WHY. The repo shipped an .npmrc holding one key — `build_from_source=true` — and npm has
// never supported it: every single install printed
//
//     npm warn Unknown project config "build_from_source". This will stop working in the
//     next major version of npm.
//
// That is a deprecation with a date on it: a future npm turns the warning into an error and
// `npm install` stops. The key was also doing nothing we needed. The mechanism that actually
// compiles node-pty and better-sqlite3 from source against ELECTRON's ABI is
// `buildDependenciesFromSource: true` in electron-builder.yml — applied by the postinstall
// (`electron-builder install-app-deps`) and again by `npm run dist*` at packaging. CI's
// native-rebuild jobs don't read it either: they pass `--build-from-source` to node-gyp on the
// command line. All `build_from_source` ever steered was the transient per-package install
// step, and the binary IT would have accepted is built for plain Node's ABI — which Electron
// cannot load and the postinstall overwrites regardless. The key bought nothing and warned on
// every install, forever. It is gone; this gate is what keeps it gone.
//
// Two layers, because either one alone can be fooled:
//   STATIC   the root .npmrc (if one ever returns) holds only sanctioned keys. Catches the key
//            before npm ever runs — no network, no node_modules, no npm needed.
//   DYNAMIC  a real `npm install --dry-run` must print no config warning. This is the
//            authoritative signal and the reason the gate is not just a grep: it catches keys
//            nobody thought to denylist, including ones arriving from ~/.npmrc or the
//            environment rather than from this repo.
//
// THREE TRAPS, all proven on this machine, none of them cosmetic — do not "simplify" them away:
//
//   * spawnSync, NOT execFileSync. npm exits 0 and writes the warning to STDERR. execFileSync
//     returns STDOUT ONLY and throws nothing on a zero exit, so an execFileSync gate sees an
//     empty string and reports PASS — blind at exactly the moment it matters. spawnSync hands
//     back both streams and never throws.
//
//   * One command STRING plus shell:true — not an args array. On Windows `npm` is npm.cmd:
//     bare `npm` is ENOENT, and since the CVE-2024-27980 fix Node refuses to spawn a .cmd
//     without a shell (EINVAL). An args array with shell:true does work, but trips DEP0190 in
//     Node 24 (args are concatenated, not escaped). A fixed literal string sidesteps all three.
//     Same pattern, same reason, as scripts/rebuild-native.mjs.
//
//   * The warning for a root .npmrc says "Unknown PROJECT config" — not "unknown config", not
//     "unknown env config". The scope word varies (project/user/global/env/builtin), so match
//     it loosely or the gate misses the very key it was written to kill.
//
// Same family as check-gates.mjs and check-docs-refs.mjs: a thing that is invisible when wrong,
// free to check, and had already been wrong for a long time.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const npmrc = join(repo, '.npmrc')

// ── STATIC ───────────────────────────────────────────────────────────────────────────────
// Keys that may legitimately appear in a root .npmrc. Deliberately small: this list is a
// decision, not an inventory. Adding a key here should take a moment's thought about whether
// the repo really wants to change npm's behaviour for everyone who clones it.
const ALLOWED = new Set([
  'audit',
  'engine-strict',
  'foreground-scripts',
  'fund',
  'legacy-peer-deps',
  'loglevel',
  'package-lock',
  'registry',
  'save-exact'
])

// Keys we have specifically been burned by. The message matters more than the failure: the
// next person to reach for this key needs to know where the behaviour actually lives.
const DENIED = new Map(
  ['build_from_source', 'build-from-source'].map((key) => [
    key,
    'npm has never supported this key — it warns on every install and will hard-fail in the next major.\n' +
      "    Building the native modules from source is electron-builder's job and it already does it:\n" +
      '    `buildDependenciesFromSource: true` in electron-builder.yml, applied by the postinstall\n' +
      '    (`electron-builder install-app-deps`) and again at packaging. Nothing to add here.'
  ])
)

const offenders = []
if (existsSync(npmrc)) {
  readFileSync(npmrc, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) return
      // No `=` means npm reads the bare word as `key=true`. `key[]=v` is npm's array syntax.
      const key = (line.split('=')[0] ?? '').trim().replace(/\[\]$/, '').toLowerCase()
      if (!key || ALLOWED.has(key)) return
      offenders.push({
        line: i + 1,
        key,
        why: DENIED.get(key) ?? 'not a sanctioned key. If npm really supports it and the repo really wants it, add it to ALLOWED in this script — on purpose.'
      })
    })
}

if (offenders.length) {
  console.error(`\nNPM CONFIG: ${offenders.length} unsanctioned key(s) in .npmrc.\n`)
  for (const { line, key, why } of offenders) console.error(`  .npmrc:${line}  ${key}\n    ${why}\n`)
  console.error('A key npm does not understand is a warning on every install and an error in the next major.\n')
  process.exit(1)
}

// ── DYNAMIC ──────────────────────────────────────────────────────────────────────────────
// The authoritative check: run npm for real and read what it says. Side-effect-free by
// construction — --dry-run writes nothing, --ignore-scripts runs no lifecycle hook,
// --package-lock-only keeps it to the lockfile (so it works offline and never touches
// node_modules), --no-audit --no-fund drop the two network calls we don't need.
const CMD = 'npm install --dry-run --ignore-scripts --package-lock-only --no-audit --no-fund'

const res = spawnSync(CMD, { cwd: repo, encoding: 'utf8', shell: true, timeout: 180_000, windowsHide: true })
const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`

// "npm warn Unknown project config "x"." / "npm warn invalid config loglevel=…". The scope word
// is optional and varies; so does unknown-vs-invalid. Both are config warnings and neither may
// survive an install.
const CONFIG_WARNING = /npm\s+warn/i
const CONFIG_SUBJECT = /(unknown|invalid)\s+(?:\w+\s+)?config/i
const warned = output.split('\n').filter((l) => CONFIG_WARNING.test(l) && CONFIG_SUBJECT.test(l))

// Warnings first: if npm both warned AND failed, the warning is still the finding.
if (warned.length) {
  console.error(`\nNPM CONFIG: \`npm install\` emits ${warned.length} config warning(s).\n`)
  for (const line of warned) console.error(`  ${line.trim()}`)
  console.error(
    '\nEach names the scope it came from: "project" is this repo\'s .npmrc, "user" is ~/.npmrc,\n' +
      '"env" is an npm_config_* variable in your shell. Remove the key at its source.\n' +
      'For build_from_source: electron-builder.yml already sets buildDependenciesFromSource.\n'
  )
  process.exit(1)
}

// npm printed no warning — but only because it RAN. An npm that never got off the ground
// prints no warnings either, and that must never read as a pass.
if (res.error || res.status !== 0) {
  const why = res.error?.code === 'ETIMEDOUT' || res.signal ? 'timed out' : (res.error?.message ?? `exit ${res.status}`)
  console.error(`\nNPM CONFIG: could not run npm — ${why}. This is NOT a pass.\n`)
  console.error(`  ${CMD}\n`)
  const tail = output.trim().split('\n').slice(-12)
  if (tail.length && tail[0]) for (const line of tail) console.error(`  ${line}`)
  console.error('\nThe dry run reads the lockfile and needs no network. If npm itself is missing or broken,')
  console.error('fix that: a gate that cannot run its check has not verified anything.\n')
  process.exit(1)
}

const state = existsSync(npmrc) ? '.npmrc holds only sanctioned keys' : 'no root .npmrc'
console.log(`  npm config OK — ${state}, and \`npm install\` emits no config warnings`)
