#!/usr/bin/env node
// The connection bridge (ADR 0014).
//
// A CLI spawns this as an ordinary stdio MCP server. It holds NO credential and
// speaks to no third party: every JSON-RPC frame the agent sends is forwarded, as
// is, over the app's token-authed LOCAL socket — the same endpoint the house MCP
// server already uses (nothing new listens, nothing on TCP; ADR 0008.b stands).
// The app attaches the OAuth token on the far side and calls the real server.
//
// That is the whole point: what lands in `~/.claude.json` for a connected service
// is a COMMAND and a service id. No token, no key, no `${VAR}` to leak — not even an
// `env` map: the entry names a SHIM that sets ELECTRON_RUN_AS_NODE itself, so the
// stored entry passes the registry validator (which refuses any env literal) without
// a hole being punched in it. There is nothing in that config file worth stealing,
// because the credential never comes here.
//
//   claude.json -> { "command": "<...>/bin/mogging-connection.cmd",
//                    "args": ["--connection", "sentry"] }
//
// If the app is not running, the connection is not available — and this says so in
// one sentence, rather than hanging or pretending the service is down. That is the
// honest cost of the app owning the grant.
import { connectEndpoint } from './lib/endpoint-client.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROTOCOL = 8 // keep in sync with DAEMON_PROTOCOL_VERSION (scripts/check-protocol-version.mjs)
const CHANNEL = process.argv.includes('--dev') || process.env.MOGGING_CHANNEL === 'dev' ? 'dev' : 'prod'
const RUN_SEGMENT = (CHANNEL === 'dev' ? 'dev-v' : 'v') + PROTOCOL

const argIndex = process.argv.indexOf('--connection')
const CONNECTION = argIndex >= 0 ? process.argv[argIndex + 1] : ''
if (!CONNECTION || !/^[a-z0-9_-]{1,64}$/i.test(CONNECTION)) {
  process.stderr.write('mogging-connection: pass --connection <service-id>\n')
  process.exit(2)
}

function runtimeBase() {
  return process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
}
const endpointFile = () =>
  process.env.MOGGING_BROWSER_ENDPOINT || join(runtimeBase(), 'MoggingLabs', 'run', RUN_SEGMENT, 'browser-control.json')

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

// One lazy authed session, single-flighted: agents pipeline calls, and two
// concurrent connects would leak the loser's socket.
let session = null
let connecting = null
let nextId = 1
const waiting = new Map()

async function open() {
  const sess = await connectEndpoint(endpointFile(), {})
  sess.onMessage((m) => {
    if (m.t === 'result' && waiting.has(m.id)) {
      const resolve = waiting.get(m.id)
      waiting.delete(m.id)
      resolve(m)
    }
  })
  // The app quit mid-session: answer every in-flight call rather than hang the
  // agent forever on a socket that will never speak again.
  sess.onClose(() => {
    if (session === sess) session = null
    const pending = [...waiting.values()]
    waiting.clear()
    for (const resolve of pending) resolve({ ok: false, reason: 'MoggingLabs Workspace closed the connection.' })
  })
  session = sess
  return sess
}

async function callApp(payload) {
  let sess = session
  if (!sess) {
    connecting =
      connecting ??
      open().finally(() => {
        connecting = null
      })
    try {
      sess = await connecting
    } catch (e) {
      return {
        ok: false,
        reason:
          e.code === 'auth'
            ? 'MoggingLabs Workspace refused the connection.'
            : `MoggingLabs Workspace is not running, so the ${CONNECTION} connection is unavailable. Open the app and retry.`
      }
    }
  }
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    if (!sess.send({ t: 'call', id, name: 'connection.rpc', args: { connection: CONNECTION, payload } })) {
      waiting.delete(id)
      resolve({ ok: false, reason: 'MoggingLabs Workspace closed the connection.' })
    }
  })
}

/** JSON-RPC error the agent can actually read, in the frame it expects. */
const rpcError = (id, message) => ({ jsonrpc: '2.0', id, error: { code: -32001, message } })

// Exiting the moment stdin closes DROPS any reply still in flight — the round trip
// through the app is async, so a client that writes one frame and closes its pipe
// got silence instead of its answer. Close is a signal to STOP READING, not a
// licence to abandon work we already accepted.
let stdinClosed = false
let inFlight = 0
const maybeExit = () => {
  if (stdinClosed && inFlight === 0) process.exit(0)
}

async function handle(msg) {
  inFlight++
  try {
    const res = await callApp(msg)
    // A notification has no id: the spec forbids a response, and sending one anyway
    // makes strict clients drop the whole session.
    if (msg.id === undefined || msg.id === null) return
    if (!res.ok) {
      write(rpcError(msg.id, res.reason ?? 'The connection is unavailable.'))
      return
    }
    // The app hands back the server's own JSON-RPC response, untouched. Its `id`
    // already matches; we do not rewrite it.
    if (res.payload && typeof res.payload === 'object') write(res.payload)
    else write(rpcError(msg.id, 'The service returned nothing.'))
  } finally {
    inFlight--
    maybeExit()
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // a frame we cannot parse is not a frame we can answer
    }
    void handle(msg)
  }
})
process.stdin.on('close', () => {
  stdinClosed = true
  maybeExit()
})
