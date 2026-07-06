#!/usr/bin/env node
// The house MCP server (Phase-6/05b browser tools; Phase-8/02 makes it THE
// server, `mogging`). Stdio JSON-RPC 2.0 to the agent; a pure CLIENT of two
// token-authed LOCAL sockets it does not own (nothing listens on TCP, no
// daemon-protocol change — v3 untouched):
//   browser family  -> the app's browser-control endpoint (consent enforced
//                      app-side, per-workspace, default OFF — ADR 0002)
//   control family  -> the PTY daemon socket the `mogging` CLI already speaks
//                      (READ half this step; writes arrive behind the 8/03
//                      per-workspace grant — never served here, never stubbed)
// The catalog is DATA: `bin/mcp-catalog.json`, build-copied from
// `src/contracts/integrations/mcp-catalog.json` (both committed; the MCP smoke
// byte-compares them). Dispatch derives from each entry's family + verb.
// Stateless: every control call is a fresh daemon round-trip; nothing is
// cached, no history kept. The server holds NO auth of its own and reads no
// cookies; tokens live only in hello frames and never in errors or logs.
//
// Register (until the phase-8 MCP manager automates it):
//   claude mcp add mogging -- node <path>/bin/mogging-mcp.mjs
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectEndpoint } from './lib/endpoint-client.mjs'

const PROTOCOL = 3
const __dirname = fileURLToPath(new URL('.', import.meta.url))

function runtimeBase() {
  return process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_RUNTIME_DIR || join(homedir(), 'Library', 'Application Support')
}

/** App (browser-control) endpoint file — same discovery as 6/05b. */
function appEndpointFile() {
  if (process.env.MOGGING_BROWSER_ENDPOINT) return process.env.MOGGING_BROWSER_ENDPOINT
  return join(runtimeBase(), 'MoggingLabs', 'run', 'v' + PROTOCOL, 'browser-control.json')
}

/** Daemon endpoint file — the `mogging` CLI's discovery, exactly: injected
 *  inside panes, well-known per-user runtime path outside. */
function daemonEndpointFile() {
  if (process.env.MOGGING_DAEMON_ENDPOINT) return process.env.MOGGING_DAEMON_ENDPOINT
  return join(runtimeBase(), 'MoggingLabs', 'run', 'v' + PROTOCOL, 'endpoint.json')
}

// ── The catalog (ONE piece of data; the hand-written array died in 8/02) ─────
const CATALOG = JSON.parse(readFileSync(join(__dirname, 'mcp-catalog.json'), 'utf8'))
// Served this step: the browser family + control READS. Write tools are not
// listed, not flagged, not stubbed — they arrive with the 8/03 grant.
const SERVED = CATALOG.filter((t) => t.access !== 'write')
const byName = new Map(CATALOG.map((t) => [t.name, t]))

let VERSION = '0.0.0'
try {
  VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version || VERSION
} catch {
  /* packaged layouts may differ; the version is informational */
}

// ── App upstream (browser + app-side control reads): one lazy authed session ─
let appSession = null
let nextAppId = 1
const appPending = new Map()

async function callApp(name, args) {
  if (!appSession) {
    let sess
    try {
      sess = await connectEndpoint(appEndpointFile())
    } catch (e) {
      throw new Error(
        e.code === 'auth'
          ? 'the MoggingLabs app refused the connection (auth)'
          : 'the MoggingLabs app is not running (no browser-control endpoint)'
      )
    }
    sess.onMessage((m) => {
      if (m.t === 'result' && appPending.has(m.id)) {
        const resolve = appPending.get(m.id)
        appPending.delete(m.id)
        resolve(m)
      }
    })
    // App gone mid-session (quit/crash): drop the session so the next call
    // re-discovers, and answer every in-flight call cleanly — never a hang,
    // never a write to a dead socket.
    sess.onClose(() => {
      if (appSession === sess) appSession = null
      const waiting = [...appPending.values()]
      appPending.clear()
      for (const resolve of waiting) resolve({ ok: false, reason: 'the MoggingLabs app closed the connection' })
    })
    appSession = sess
  }
  const id = nextAppId++
  return new Promise((resolve) => {
    appPending.set(id, resolve)
    appSession.send({ t: 'call', id, name, args })
  })
}

// ── Daemon upstream: a fresh authed round-trip per call (stateless) ──────────
async function callDaemon(msg, replyTypes) {
  let sess
  try {
    sess = await connectEndpoint(daemonEndpointFile())
  } catch (e) {
    const err = new Error(
      e.code === 'auth'
        ? 'the MoggingLabs daemon refused the connection (auth)'
        : 'the MoggingLabs daemon is not running — open the app (or a pane), or point MOGGING_DAEMON_ENDPOINT at its endpoint file'
    )
    err.rpc = true // connection-level: a clean JSON-RPC error, not a tool error
    throw err
  }
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error('the MoggingLabs daemon did not respond in time')
        err.rpc = true
        reject(err)
      }, 5000)
      sess.onMessage((m) => {
        if (replyTypes.includes(m.t) || m.t === 'error') {
          clearTimeout(timer)
          resolve(m)
        }
      })
      sess.send(msg)
    })
  } finally {
    sess.close()
  }
}

// ── MCP stdio JSON-RPC 2.0 ───────────────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function replyErr(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}
function toolText(id, text) {
  reply(id, { content: [{ type: 'text', text }] })
}
function toolError(id, text) {
  reply(id, { content: [{ type: 'text', text }], isError: true })
}

/** Validate args against the catalog entry's own inputSchema (required keys +
 *  primitive types) — malformed args are a spec error, not a crash. Returns an
 *  error string or null. */
function argsProblem(def, args) {
  const schema = def.inputSchema
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `missing required argument "${key}"`
  }
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key]
    if (!prop) return `unknown argument "${key}"`
    if (typeof val !== prop.type) return `argument "${key}" must be a ${prop.type}`
    if (prop.enum && !prop.enum.includes(val)) return `argument "${key}" must be one of: ${prop.enum.join(', ')}`
  }
  return null
}

/** Session identity: the pane this server was spawned inside (agent CLIs pass
 *  their env down), or the human view outside a pane — same rule as the CLI. */
const paneIdentity = () => process.env.MOGGING_PANE_ID || undefined

async function handleBrowserCall(id, def, args) {
  try {
    const r = await callApp(def.verb, args)
    if (!r.ok) {
      const hint =
        r.reason === 'disabled'
          ? 'Agent browser control is OFF for this workspace. The human enables it in Settings > Browser.'
          : `browser tool failed: ${r.reason || 'unknown'}`
      toolError(id, hint)
      return
    }
    // Shape the result as MCP text content (screenshots return the data URL).
    const payload = {}
    for (const k of ['url', 'title', 'text', 'value', 'png']) if (r[k] !== undefined) payload[k] = r[k]
    if (r.nodes) payload.nodes = r.nodes
    if (r.lines) payload.lines = r.lines
    toolText(id, Object.keys(payload).length ? JSON.stringify(payload) : 'ok')
  } catch (e) {
    toolError(id, String(e.message || e))
  }
}

async function handleControlCall(id, def, args) {
  try {
    if (def.upstream === 'app') {
      // board.list — the board lives app-side; card text goes to the CALLING
      // MODEL only (same class as capture: never telemetry, logs, app state).
      const r = await callApp(def.verb, args)
      if (!r.ok) {
        toolError(id, `board read failed: ${r.reason || 'the app could not list the board'}`)
        return
      }
      toolText(id, JSON.stringify(r.cards ?? []))
      return
    }
    switch (def.verb) {
      case 'list': {
        const m = await callDaemon({ t: 'list' }, ['panes'])
        toolText(id, JSON.stringify(m.panes ?? []))
        return
      }
      case 'capture': {
        // Scrollback tail to the CALLING MODEL only — never app state,
        // telemetry, or logs (ADR 0002/0005, exactly like `mogging capture`).
        const lines = Math.min(Math.max(1, Math.floor(args.lines ?? 1000)), 10000)
        const m = await callDaemon({ t: 'capture', id: String(args.pane), lastLines: lines }, ['captured'])
        if (m.t === 'error') {
          toolError(id, `unknown pane ${args.pane}`)
          return
        }
        toolText(id, m.data ?? '')
        return
      }
      case 'mail-read': {
        const m = await callDaemon(
          { t: 'mail-read', since: args.since ?? 0, for: paneIdentity() },
          ['mail']
        )
        toolText(id, JSON.stringify(m.messages ?? []))
        return
      }
      case 'owners': {
        const m = await callDaemon({ t: 'owners' }, ['owners'])
        toolText(id, JSON.stringify(m.claims ?? []))
        return
      }
      default:
        toolError(id, `unroutable control verb: ${def.verb}`)
        return
    }
  } catch (e) {
    if (e.rpc) replyErr(id, -32000, String(e.message || e))
    else toolError(id, String(e.message || e))
  }
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  const def = byName.get(name)
  if (!def) {
    replyErr(id, -32602, `unknown tool: ${name}`)
    return
  }
  if (def.access === 'write') {
    // Never a stub: write tools arrive behind the per-workspace grant (8/03,
    // default off). Until then a write call is a spec error, plainly worded.
    replyErr(id, -32602, `"${name}" is a write tool — write tools arrive behind the per-workspace integrations grant (phase 8/03) and are not served yet`)
    return
  }
  const problem = argsProblem(def, args)
  if (problem) {
    replyErr(id, -32602, `${name}: ${problem}`)
    return
  }
  if (def.family === 'browser') await handleBrowserCall(id, def, args)
  else await handleControlCall(id, def, args)
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
      continue
    }
    const { id, method, params } = msg
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'mogging', version: VERSION }
      })
    } else if (method === 'tools/list') {
      reply(id, {
        tools: SERVED.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      })
    } else if (method === 'tools/call') {
      void handleToolCall(id, params)
    } else if (method === 'ping') {
      reply(id, {})
    } else if (id !== undefined) {
      replyErr(id, -32601, 'method not found: ' + method)
    }
    // notifications (no id) are acknowledged by silence
  }
})
