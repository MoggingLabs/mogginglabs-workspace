#!/usr/bin/env node
// The daemon-protocol-version gate.
//
//   node scripts/check-protocol-version.mjs
//
// THE RULE: DAEMON_PROTOCOL_VERSION has exactly one value, and all three declarations agree.
//
// It is declared three times because the two `bin/` entry points are plain Node and cannot import
// a TS contract:
//   src/contracts/daemon/protocol.ts   DAEMON_PROTOCOL_VERSION   (the app + daemon)
//   bin/mogging.mjs                    PROTOCOL_VERSION          (the CLI)
//   bin/mogging-mcp.mjs                PROTOCOL                  (the MCP server)
//
// A "keep in sync" comment guarded them, which is to say nothing guarded them. The version names
// the runtime DIRECTORY (…/MoggingLabs/run/v<N>) holding the daemon socket, the endpoint file, the
// browser-control endpoint and sessions.db — so a stale value does not throw or warn. Every verb
// simply reports "the daemon is not running", forever, on a machine where it plainly is.
//
// Precedent: the build already byte-compares bin/mcp-catalog.json against the contract it is copied
// from, so drift fails a gate instead of shipping. Same idea, one constant.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

function walkTs(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const SOURCES = [
  { file: 'src/contracts/daemon/protocol.ts', re: /export const DAEMON_PROTOCOL_VERSION\s*=\s*(\d+)/ },
  { file: 'bin/mogging.mjs', re: /^const PROTOCOL_VERSION\s*=\s*(\d+)/m },
  { file: 'bin/mogging-mcp.mjs', re: /^const PROTOCOL\s*=\s*(\d+)/m }
]

const found = SOURCES.map(({ file, re }) => {
  const m = re.exec(readFileSync(file, 'utf8'))
  if (!m) {
    console.error(`\nPROTOCOL GATE: could not find the version declaration in ${file}.`)
    console.error('The gate is now blind — fix the pattern in scripts/check-protocol-version.mjs.\n')
    process.exit(1)
  }
  return { file, version: Number(m[1]) }
})

const versions = new Set(found.map((f) => f.version))
if (versions.size !== 1) {
  console.error('\nDAEMON PROTOCOL VERSION MISMATCH — the CLI and the app would look in different runtime dirs.\n')
  for (const { file, version } of found) console.error(`  v${version}  ${file}`)
  console.error('\nA stale value never errors: the CLI reports "the daemon is not running" against a live daemon.\n')
  process.exit(1)
}

// The three above are unavoidable (plain Node cannot import a TS contract). A FOURTH copy is not:
// src/main/mcp-endpoint.ts once hardcoded `const PROTOCOL = 3` and kept writing browser-control.json
// into the v3 dir after the daemon moved to v4 — the browser tools simply never connected. Anything
// under src/ that is not the contract itself must IMPORT the constant, never restate it.
const LITERAL = /^\s*(?:export\s+)?const\s+(?:DAEMON_)?PROTOCOL(?:_VERSION)?\s*(?::\s*number\s*)?=\s*\d+/m
const OWNER = 'src/contracts/daemon/protocol.ts'
const restated = []
for (const file of walkTs('src')) {
  if (file.split(sep).join('/') === OWNER) continue
  if (LITERAL.test(readFileSync(file, 'utf8'))) restated.push(file.split(sep).join('/'))
}
if (restated.length) {
  console.error('\nPROTOCOL VERSION RESTATED IN TYPESCRIPT — import it from @contracts instead.\n')
  for (const f of restated) console.error(`  ${f}`)
  console.error(`\nOnly ${OWNER} may hold the literal. A stale copy routes the app at a directory nobody reads.\n`)
  process.exit(1)
}

// The CHANNEL literals are the same class of unavoidable duplication: contracts derives
// run/dev-v<N> + mogging-dev://, and the plain-Node satellites restate the derivation. If one
// drifts (e.g. someone renames the dev segment in contracts only), the dev CLI looks in a
// directory no daemon writes — the same silent "not running" failure the version gate exists for.
// The statusline relay is the third satellite: its SOURCE is a plain-Node script (generated to
// disk, run by Claude Code inside a pane), so it cannot import the contract either. It derives the
// same segment to name the context SINK dir, and a drift there is just as quiet — the dev app and
// the installed release would write and poll different dirs, and the context bar simply stays
// empty. It is gated here for exactly the reason the two bins are.
const CHANNEL_SOURCES = [
  {
    file: 'src/contracts/daemon/protocol.ts',
    checks: [/'dev-v' : 'v'/, /'mogging-dev' : 'mogging'/]
  },
  { file: 'bin/mogging.mjs', checks: [/'dev-v' : 'v'/, /'mogging-dev' : 'mogging'/] },
  { file: 'bin/mogging-mcp.mjs', checks: [/'dev-v' : 'v'/] },
  { file: 'src/backend/features/context/relay.ts', checks: [/'dev-v' : 'v'/] }
]
for (const { file, checks } of CHANNEL_SOURCES) {
  const src = readFileSync(file, 'utf8')
  for (const re of checks) {
    if (!re.test(src)) {
      console.error(`\nCHANNEL DRIFT: ${file} no longer derives the release channel as ${re}.`)
      console.error('dev (run/dev-v<N>, mogging-dev://) and prod (run/v<N>, mogging://) must agree everywhere.\n')
      process.exit(1)
    }
  }
}

console.log(`  daemon protocol OK — ${found.length} declarations agree on v${[...versions][0]}, none restated in src/, channel literals in sync`)
