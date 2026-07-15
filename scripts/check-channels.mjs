#!/usr/bin/env node
// The preload-allowlist gate.
//
//   node scripts/check-channels.mjs
//
// THE RULE: every `export const XxxChannels = { … }` map in src/contracts/ipc/channels.ts is
// spread into AllChannels, and nothing in AllChannels names a map that does not exist.
//
// AllChannels IS the preload security allowlist (src/preload/index.ts builds its Set from it),
// and it is hand-maintained: 26 spreads that a new feature's author must remember to extend.
// A forgotten spread does not throw or warn anywhere — every invoke/send/on for that feature
// is refused by the bridge with "ipc channel not allowed", which reads as a feature bug, not
// a list bug. This repo gates every other list-that-must-agree (check-gates, check-protocol-
// version, check-gate-count); this was the one left unguarded.
//
// Same family, same shape: parse both sides of the agreement out of the ONE file that holds
// them, and fail loudly with the missing name.
import { readFileSync } from 'node:fs'

const FILE = 'src/contracts/ipc/channels.ts'
const src = readFileSync(FILE, 'utf8')

// Every exported channel map (the aggregate itself is typed `readonly string[]`, not a map).
const maps = [...src.matchAll(/^export const (\w+Channels)\s*=\s*\{/gm)].map(([, name]) => name)
if (!maps.length) {
  console.error(`\nCHANNEL GATE: found no channel maps in ${FILE} — the pattern is blind.\n`)
  process.exit(1)
}

const aggregate = /export const AllChannels[^=]*=\s*\[([\s\S]*?)\]/.exec(src)?.[1]
if (!aggregate) {
  console.error(`\nCHANNEL GATE: could not find AllChannels in ${FILE} — the pattern is blind.\n`)
  process.exit(1)
}

const spread = [...aggregate.matchAll(/\.\.\.Object\.values\((\w+)\)/g)].map(([, name]) => name)
const spreadSet = new Set(spread)

const missing = maps.filter((name) => !spreadSet.has(name))
const unknown = spread.filter((name) => !maps.includes(name))

if (missing.length || unknown.length) {
  console.error('\nPRELOAD ALLOWLIST DRIFT — AllChannels disagrees with the channel maps beside it.\n')
  for (const name of missing) console.error(`  ${name.padEnd(24)} declared but NOT spread into AllChannels — its every IPC call is refused by the preload`)
  for (const name of unknown) console.error(`  ${name.padEnd(24)} spread into AllChannels but no such map exists`)
  console.error(`\nAdd the spread in ${FILE} (the aggregate is the single intentional shared touch point).\n`)
  process.exit(1)
}

console.log(`  preload allowlist OK — ${maps.length} channel maps, all spread into AllChannels`)
