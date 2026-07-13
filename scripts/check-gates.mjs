#!/usr/bin/env node
// The gate-registry gate.
//
//   node scripts/check-gates.mjs
//
// THE RULE: every gate in the sweep is a gate the APP knows about — dispatched in
// src/main/index.dev.ts, and named in its SMOKE_ENV allowlist.
//
// Three lists have to agree and nothing made them:
//   scripts/qa-smokes.sh   run_smoke NAME MOGGING_X …   (the sweep runs it)
//   src/main/index.dev.ts  process.env.MOGGING_X        (the app runs the smoke)
//   src/main/index.dev.ts  SMOKE_ENV = [… 'MOGGING_X' …] (the app knows it IS a smoke)
//
// index.DEV.ts, not index.ts — since audit finding 41 there are two entries over one boot.ts, and
// electron-vite picks by command: `serve` (npm run dev, which every gate runs) gets index.dev.ts,
// `build` gets the production index.ts, which imports NONE of this. That is the point: the harness
// is not in the shipped app.asar. scripts/check-prod-artifact.mjs enforces the absence; this gate
// enforces the presence. Both entries emit out/main/index.js, so the sweep is unchanged.
//
// Drift in the third list is the quiet kind. `isSmoke` decides whether the app skips the
// single-instance lock, the deep-link registration and auto-update — so a gate the allowlist
// has never heard of runs as a REAL app: it takes the lock, registers the OS-global
// mogging:// scheme, and phones the update server. It still passes today only because every
// gate also exports MOGGING_USERDATA, which IS allowlisted — a fallback, not a plan. Ten
// gates arrived that way in one merge (typed's three, Phase 11's seven).
//
// Same family as check-protocol-version.mjs: a list that must agree with another list, and
// nothing but a gate ever makes lists agree.
import { readFileSync } from 'node:fs'

const ENTRY = 'src/main/index.dev.ts'
const sweep = readFileSync('scripts/qa-smokes.sh', 'utf8')
const index = readFileSync(ENTRY, 'utf8')

const gates = [...sweep.matchAll(/^run_smoke\s+(\S+)\s+(MOGGING_\w+)/gm)].map(([, name, env]) => ({ name, env }))
if (!gates.length) {
  console.error('\nGATE REGISTRY: found no `run_smoke` rows in scripts/qa-smokes.sh — the pattern is blind.\n')
  process.exit(1)
}

const smokeEnv = /const SMOKE_ENV[^=]*=\s*\[([\s\S]*?)\]/.exec(index)?.[1] ?? ''
if (!smokeEnv) {
  console.error(`\nGATE REGISTRY: could not find SMOKE_ENV in ${ENTRY} — the pattern is blind.\n`)
  process.exit(1)
}

const undispatched = gates.filter((g) => !new RegExp(`process\\.env\\.${g.env}\\b`).test(index))
const unlisted = gates.filter((g) => !new RegExp(`'${g.env}'`).test(smokeEnv))

if (undispatched.length || unlisted.length) {
  console.error('\nGATE REGISTRY DRIFT — the sweep runs gates the app does not know about.\n')
  for (const g of undispatched) console.error(`  ${g.name.padEnd(16)} ${g.env}  not dispatched in ${ENTRY}`)
  for (const g of unlisted) console.error(`  ${g.name.padEnd(16)} ${g.env}  missing from SMOKE_ENV — would run as a REAL app`)
  console.error('\nA gate outside SMOKE_ENV takes the single-instance lock, registers the deep-link')
  console.error('scheme, and contacts the update server. It only survives on the MOGGING_USERDATA')
  console.error('fallback — add the name.\n')
  process.exit(1)
}

console.log(`  gate registry OK — ${gates.length} gates, all dispatched and allowlisted`)
