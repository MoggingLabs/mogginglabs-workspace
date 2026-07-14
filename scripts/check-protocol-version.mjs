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
import { createHash } from 'node:crypto'
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


// ── THE WIRE FINGERPRINT ──────────────────────────────────────────────────────────────────
//
// The version gate above only proves the three declarations agree on a NUMBER. It cannot see
// the thing that actually matters: whether the wire those numbers describe has CHANGED.
//
// It changed once, silently, and the release would have been a no-op. The alerts rewrite added
// `done` and `unknown` to AgentState — a state the daemon emits and the app reads. But the
// DAEMON OUTLIVES THE APP (ADR 0006): after an update, the new app finds the surviving daemon in
// run/v<N> and simply reconnects to it. That daemon is a separate long-lived process still
// running the OLD code, so it would never emit `done` at all — every green in the product would
// have quietly stopped working for everyone who upgraded without rebooting, and nothing would
// have failed. Bumping the version is what routes the app to a fresh run/v<N+1> and triggers the
// migrate-and-retire hand-off (lifecycle.otherVersionEndpoints) that carries their live agents
// across.
//
// So: fingerprint the SHAPE of everything that crosses the socket, and pin it to the version.
// Change the wire -> the hash moves -> this gate fails and tells you to bump. Comments and
// formatting are stripped, so prose edits are free; only the declarations count. Precedent: the
// build already byte-compares bin/mcp-catalog.json against the contract it is copied from.
const WIRE_FILES = [
  'src/contracts/domain/agent.ts',
  'src/contracts/daemon/protocol.ts',
  // THE DAEMON CARRIES BEHAVIOUR, NOT JUST A WIRE. The ActivityTracker RUNS INSIDE THE DAEMON
  // (pty-daemon/session.ts holds one per pane), so a stale daemon runs a stale tracker — and the
  // wire it speaks is byte-identical while it does. v0.11.0 shipped a tracker that reddened every
  // finished turn; the v0.11.1 fix would have reached NOBODY, because the app reconnects to the
  // surviving daemon and the wire hash never moved. The question this gate exists to ask was
  // never "did the wire change" — it is "does a daemon already running the OLD CODE still behave
  // correctly?" For anything the daemon executes, a code change means no.
  'src/backend/features/agent-state/activity.ts'
]

/** The declarations, and nothing else: comments gone, whitespace collapsed, and the version
 *  constant itself removed — the fingerprint describes the SHAPE of the wire, not the number
 *  stamped on it, or bumping the version would "fix" its own gate. */
function wireFingerprint() {
  const norm = WIRE_FILES.map((f) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
      .replace(/\/\/.*$/gm, ' ') // line comments
      .replace(/export const DAEMON_PROTOCOL_VERSION\s*=\s*\d+/, '') // the number, not the shape
      .replace(/\s+/g, ' ')
      .trim()
  ).join('|')
  return createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

// Bump BOTH together. If this gate fails, ask the one question it exists to ask:
//
//     Does a daemon that is ALREADY RUNNING THE OLD CODE still behave correctly?
//
// Not "does it still speak this wire" — that was the narrow version of the question, and it let
// v0.11.1 through. The tracker's own bug fix changed no wire at all, so the hash never moved, and
// the surviving daemon would have gone on reddening every finished turn for as long as the machine
// stayed up. Any change to code the DAEMON EXECUTES means the answer is no, and the version must
// move so the old daemon is retired and its sessions migrated rather than reconnected to.
const PINNED = { version: 9, fingerprint: '4ee48e9d38934fd5' }

const actualWire = wireFingerprint()
if (actualWire !== PINNED.fingerprint) {
  console.error(`\nWIRE CHANGED: the daemon contract's shape is ${actualWire}, pinned at ${PINNED.fingerprint}.`)
  console.error('Something that crosses the daemon socket was added, removed or reshaped.')
  console.error('')
  console.error('The daemon OUTLIVES the app. An updated app reconnects to the daemon already')
  console.error('running — which still holds the OLD code — unless DAEMON_PROTOCOL_VERSION moves.')
  console.error('A wire change without a bump ships a feature that silently does nothing.')
  console.error('')
  console.error(`  1. bump DAEMON_PROTOCOL_VERSION (all 3 declarations) — currently v${PINNED.version}`)
  console.error('  2. re-pin in scripts/check-protocol-version.mjs:')
  console.error(`       const PINNED = { version: <new>, fingerprint: '${actualWire}' }\n`)
  process.exit(1)
}
if (PINNED.version !== [...versions][0]) {
  console.error(`\nPIN DRIFT: the wire is pinned to v${PINNED.version} but the sources declare v${[...versions][0]}.`)
  console.error('Re-pin scripts/check-protocol-version.mjs to match.\n')
  process.exit(1)
}

console.log(`  daemon protocol OK — ${found.length} declarations agree on v${[...versions][0]}, none restated in src/, channel literals in sync, wire ${actualWire} pinned`)
