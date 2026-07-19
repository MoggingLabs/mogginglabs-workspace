#!/usr/bin/env node
// The house MCP server (Phase-6/05b browser tools; Phase-8/02 makes it THE
// server, `mogging`). Stdio JSON-RPC 2.0 to the agent; a pure CLIENT of two
// token-authed LOCAL sockets it does not own (nothing listens on TCP; it adds no
// message to the daemon protocol, but it MUST name the same version — see PROTOCOL):
//   browser family  -> the app's browser-control endpoint (consent enforced
//                      app-side, per-workspace, default OFF — ADR 0002)
//   control family  -> the PTY daemon socket the `mogging` CLI already speaks;
//                      SELF declarations are pane-capability-bound and always served;
//                      WRITES (8/03) serve only under the per-workspace grant
//                      (default OFF, resolved via the app's `grant.get`,
//                      re-checked LIVE per call, list_changed on flips; no
//                      pane identity -> no write tools, period)
// The catalog is DATA: `bin/mcp-catalog.json`, build-copied from
// `src/contracts/integrations/mcp-catalog.json` (both committed; the MCP smoke
// byte-compares them). Dispatch derives from each entry's family + verb.
// Stateless: every control call is a fresh daemon round-trip; nothing is
// cached, no history kept. The server holds NO auth of its own and reads no
// cookies; tokens live only in hello frames and never in errors or logs.
//
// Register (until the phase-8 MCP manager automates it):
//   claude mcp add mogging -- node <path>/bin/mogging-mcp.mjs
import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectEndpoint } from './lib/endpoint-client.mjs'
import { runFile } from './lib/runtime-paths.mjs'

// Keep in sync with DAEMON_PROTOCOL_VERSION in src/contracts/daemon/protocol.ts (this file is
// plain Node — it cannot import the TS contract). It names the runtime DIRECTORY both the daemon
// socket and the app's browser-control endpoint live in, so a stale value does not degrade: every
// tool silently reports "the daemon is not running". Enforced by scripts/check-protocol-version.mjs.
const PROTOCOL = 10
// Release channel (keep in sync with contracts ReleaseChannel; same gate). Inside a pane the
// MOGGING_*_ENDPOINT envs below pin the exact app, so this only decides the well-known FALLBACK
// path — run/dev-v4 when MOGGING_CHANNEL=dev is inherited (dev panes) or --dev is passed.
const CHANNEL = process.argv.includes('--dev') || process.env.MOGGING_CHANNEL === 'dev' ? 'dev' : 'prod'
const RUN_SEGMENT = (CHANNEL === 'dev' ? 'dev-v' : 'v') + PROTOCOL
const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** App (browser-control) endpoint file — same discovery as 6/05b. */
function appEndpointFile() {
  if (process.env.MOGGING_BROWSER_ENDPOINT) return process.env.MOGGING_BROWSER_ENDPOINT
  return runFile(RUN_SEGMENT, 'browser-control.json')
}

/** Daemon endpoint file — the `mogging` CLI's discovery, exactly: injected
 *  inside panes, well-known per-user runtime path outside. */
function daemonEndpointFile() {
  if (process.env.MOGGING_DAEMON_ENDPOINT) return process.env.MOGGING_DAEMON_ENDPOINT
  return runFile(RUN_SEGMENT, 'endpoint.json')
}

// ── The catalog (ONE piece of data; the hand-written array died in 8/02) ─────
const CATALOG = JSON.parse(readFileSync(join(__dirname, 'mcp-catalog.json'), 'utf8'))
const byName = new Map(CATALOG.map((t) => [t.name, t]))

// ── The per-workspace grant (8/03, ADR 0008.c) ───────────────────────────────
// Write tools are served ONLY when this session's workspace granted them: the
// app resolves pane -> workspace -> granted names (`grant.get` over the app
// endpoint), pushes `grantChanged` on flips, and every write call re-checks
// LIVE so a revoke lands mid-session. Sessions without a pane identity (a
// human running the server outside a pane) get no write tools, period.
// Fail-closed everywhere: no app, no pane, no resolution -> reads only.
let grantedWrites = new Set()

/** Serve the catalog minus ungranted general writes. Self-scoped declarations are
 *  always visible because their per-pane capability is the authorization boundary. */
const servedTools = () => CATALOG.filter((t) => t.access !== 'write' || grantedWrites.has(t.name))

const CWD_INSTRUCTIONS =
  'Call report_working_directory with the absolute path of your primary working directory at session start. ' +
  'Call it again immediately whenever you change the primary checkout or worktree. ' +
  'Do not report transient subprocess directories.'

/** Re-resolve this session's granted writes. Emits tools/list_changed when the
 *  set changed (unless suppressed — the initialize-time resolve has no
 *  listener yet). Failure -> empty set (fail closed), never a throw. */
function applyGrantSet(names, emitChange) {
  const next = new Set(names)
  const changed = next.size !== grantedWrites.size || [...next].some((n) => !grantedWrites.has(n))
  grantedWrites = next
  if (changed && emitChange) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  return next
}

async function refreshGrant(emitChange) {
  if (!paneIdentity()) return applyGrantSet([], emitChange)
  try {
    const r = await callApp('grant.get', {})
    return applyGrantSet(r.ok && Array.isArray(r.writeTools) ? r.writeTools : [], emitChange)
  } catch {
    return applyGrantSet([], emitChange) // app unreachable: fail closed
  }
}

let VERSION = '0.0.0'
try {
  VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version || VERSION
} catch {
  /* packaged layouts may differ; the version is informational */
}

// ── App upstream (browser + app-side control reads): one lazy authed session ─
let appSession = null
let appConnecting = null // the IN-FLIGHT connect, shared (see callApp)
let nextAppId = 1
const appPending = new Map()

async function connectApp() {
  let sess
  try {
    const pane = paneIdentity()
    const paneToken = process.env.MOGGING_PANE_TOKEN || undefined
    sess = await connectEndpoint(appEndpointFile(), {
      hello: pane && paneToken ? { pane, paneToken } : {}
    })
  } catch (e) {
    throw new Error(
      e.code === 'auth'
        ? 'the MoggingLabs app refused the connection (auth)'
        : 'the MoggingLabs app is not running (no browser-control endpoint)',
      { cause: e }
    )
  }
  sess.onMessage((m) => {
    if (m.t === 'result' && appPending.has(m.id)) {
      const resolve = appPending.get(m.id)
      appPending.delete(m.id)
      resolve(m)
    } else if (m.t === 'grantChanged') {
      // A grant flipped somewhere — re-resolve and tell the agent when our
      // tool set changed (revokes land mid-session; calls re-check anyway).
      void refreshGrant(true)
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
  return sess
}

async function callApp(name, args, extra) {
  let sess = appSession
  if (!sess) {
    // SINGLE-FLIGHT. Clients pipeline tool calls: two calls with no session both awaited their
    // own connectEndpoint, the last assignment won appSession, and the loser's socket was never
    // closed — a leaked connection whose grantChanged then double-fired refreshGrant.
    appConnecting =
      appConnecting ??
      connectApp().finally(() => {
        appConnecting = null
      })
    sess = await appConnecting
  }
  const id = nextAppId++
  return new Promise((resolve) => {
    appPending.set(id, resolve)
    // The socket can die between our read of appSession and this write; onClose has already
    // drained appPending by then, so an unanswerable call must resolve itself, not hang.
    if (!sess.send({ t: 'call', id, name, args, ...(extra || {}) })) {
      appPending.delete(id)
      resolve({ ok: false, reason: 'the MoggingLabs app closed the connection' })
    }
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
const paneToken = () => process.env.MOGGING_PANE_TOKEN || undefined

async function handleBrowserCall(id, def, args) {
  try {
    // The app endpoint bound this socket to our pane during hello; per-call identity is ignored.
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
    for (const k of ['url', 'title', 'text', 'value', 'png', 'truncated', 'activeTabId']) if (r[k] !== undefined) payload[k] = r[k]
    if (r.nodes) payload.nodes = r.nodes
    if (r.lines) payload.lines = r.lines
    if (r.tabs) payload.tabs = r.tabs
    toolText(id, Object.keys(payload).length ? JSON.stringify(payload) : 'ok')
  } catch (e) {
    toolError(id, String(e.message || e))
  }
}

// ── The brain's read family (ADR 0018 step 05): reads-free graph queries ─────
// Same app upstream as the board reads, same posture: the payload rides back to
// the CALLING MODEL verbatim; refusals are TYPED app-side and worded here in
// the board family's register. Reads only — brain writes do not exist.

/** reason -> a sentence a MODEL can act on (the board-read wording register). */
function brainRefusalText(r) {
  const detail = typeof r.detail === 'string' && r.detail ? r.detail : ''
  switch (r.reason) {
    case 'unknown-node':
      return detail || `unknown node (not in your project's brain)`
    case 'too-deep':
      return `refused — ${detail || 'the path walk exceeded its depth/visited caps'}`
    case 'invalid':
      return `refused — ${detail || 'the request was invalid'}`
    case 'missing':
      return `the root does not exist${detail ? ` (${detail})` : ''}`
    case 'too-large':
      return `the project exceeds the brain's index cap${detail ? ` (${detail})` : ''}`
    case 'no-map':
      return detail || 'no brain index for this checkout — nothing to map yet'
    case 'unknown-library':
      return detail || `unknown library (not in this checkout's lockfiles — see list_libraries)`
    case 'unknown-memory':
      return detail || `unknown memory (not in this project's .memory/ — see search_memories)`
    case 'consent':
      return `refused — ${detail || 'this workspace has not allowed registry doc fetches (default off); the human enables it in Settings'}`
    case 'fetch-failed':
      return `the registry fetch failed${detail ? ` (${detail})` : ''} — the on-disk answer is unchanged`
    case 'embed-failed':
      return `the embedding call failed${detail ? ` (${detail})` : ''} — the workspace's own endpoint did not answer; exact search still works (mode "exact")`
    case 'busy':
      return `the brain is busy${detail ? ` (${detail})` : ''} — retry shortly`
    default:
      return `brain read failed: ${r.reason || 'the app could not answer'}`
  }
}

/** Write-refusal wording (ADR 0018 step 07) — every sentence tells the MODEL its
 *  next move. `stale` rides with the fresh hash (the refuse-with-fresh-card
 *  shape): re-query the node, then retry against current lines. */
function brainWriteRefusalText(r) {
  const detail = typeof r.detail === 'string' && r.detail ? r.detail : ''
  switch (r.reason) {
    case 'stale':
      return (
        'refused — the file changed since your expectedFileHash.' +
        (r.freshHash ? ` Fresh hash: ${r.freshHash}.` : '') +
        ' Re-query the node (get_node) and retry against current lines.' +
        (detail ? ` (${detail})` : '')
      )
    case 'wrong-checkout':
      return `refused — ${detail || 'that symbol lives in a different checkout of this project; write from a pane standing in it'}`
    case 'forbidden':
      return 'refused — this workspace has not granted write tools (the human grants them in the app)'
    case 'unknown-node':
      return detail || `unknown node (not in your project's brain)`
    case 'missing':
      return `refused — ${detail || 'the file does not exist on disk; re-query the node'}`
    case 'too-large':
      return `refused — ${detail || 'the payload or file exceeds its byte cap'}`
    case 'invalid':
      return `refused — ${detail || 'the write was invalid'}`
    case 'busy':
      return r.landed
        ? `the write landed on disk but the re-index refused${detail ? ` (${detail})` : ''} — re-query before further edits`
        : `the brain is busy${detail ? ` (${detail})` : ''} — retry shortly`
    default:
      return `symbol write failed: ${r.reason || 'the app could not answer'}`
  }
}

/** Memory-write refusal wording (ADR 0018 step 09) — every sentence tells the
 *  MODEL its next move; `stale` rides with the fresh hash like every CAS. */
function memoryWriteRefusalText(r) {
  const detail = typeof r.detail === 'string' && r.detail ? r.detail : ''
  switch (r.reason) {
    case 'stale':
      return (
        'refused — the memory changed since your expectedFileHash.' +
        (r.freshHash ? ` Fresh hash: ${r.freshHash}.` : '') +
        ' Re-read it (get_memory) and retry against current bytes.' +
        (detail ? ` (${detail})` : '')
      )
    case 'exists':
      return `refused — ${detail || 'that memory already exists; update_memory edits it (get_memory answers its fileHash)'}`
    case 'unknown-memory':
      return detail || 'unknown memory (not in this checkout\'s .memory/) — create_memory writes new ones'
    case 'forbidden':
      return 'refused — this workspace has not granted write tools (the human grants them in the app)'
    case 'too-large':
      return `refused — ${detail || 'the body exceeds its byte cap'}`
    case 'invalid':
      return `refused — ${detail || 'the write was invalid'}`
    case 'busy':
      return `the brain is busy${detail ? ` (${detail})` : ''} — retry shortly`
    default:
      return `memory write failed: ${r.reason || 'the app could not answer'}`
  }
}

async function handleBrainCall(id, def, args) {
  try {
    // The app endpoint bound this socket to our pane during hello; a paneless
    // session passes an explicit `root` argument instead — reads are free
    // either way, and the app enforces checkout scope, not this bridge.
    const r = await callApp(def.verb, args)
    if (!r.ok) {
      toolError(id, brainRefusalText(r))
      return
    }
    const { ok: _ok, t: _t, id: _id, ...payload } = r
    toolText(id, JSON.stringify(payload))
  } catch (e) {
    toolError(id, String(e.message || e))
  }
}

async function handleControlCall(id, def, args) {
  try {
    if (def.upstream === 'app') {
      // Board reads live app-side; card text goes to the CALLING MODEL only
      // (same class as capture: never telemetry, logs, app state). The reply
      // is the endpoint's payload verbatim: list_board -> { board, cards },
      // get_card -> { card, activity }.
      const r = await callApp(def.verb, args)
      if (!r.ok) {
        toolError(id, `board read failed: ${r.reason || 'the app could not read the board'}`)
        return
      }
      const { ok: _ok, t: _t, id: _id, ...payload } = r
      toolText(id, JSON.stringify(payload))
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

// ── Self-scoped declarations: pane-capability-bound, never grant-gated ─────────

/** Dispatch a declaration that can mutate only this MCP session's own pane. The daemon
 *  requires both layers: endpoint auth proves same-user, while the per-session pane token
 *  proves this process may update the pane named by MOGGING_PANE_ID. */
async function handleSelfCall(id, def, args) {
  if (def.verb !== 'cwd-report') {
    toolError(id, `unroutable self-scoped verb: ${def.verb}`)
    return
  }
  if (!process.env.MOGGING_DAEMON_ENDPOINT) {
    // In-process and SSH panes have no local daemon endpoint. The MCP process still shares
    // the pane's controlling terminal even though its stdout is reserved for JSON-RPC, so the
    // same private OSC fallback as `mogging cwd` remains self-scoped without carrying a token.
    if (!process.env.MOGGING_PANE_ID && process.env.MOGGING_PTY !== '1') {
      replyErr(id, -32602, `"${def.name}" is unavailable outside a MoggingLabs pane`)
      return
    }
    const path = args.path
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path.length > 32 * 1024 ||
      /[\x00-\x1f\x7f]/.test(path)
    ) {
      replyErr(id, -32602, `"${def.name}" requires an absolute directory path`)
      return
    }
    try {
      if (!statSync(path).isDirectory()) throw new Error('not a directory')
      const osc = `\x1b]633;P;MoggingCwd=${encodeURIComponent(path)}\x1b\\`
      const tty = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty'
      const fd = openSync(tty, 'w')
      try {
        const bytes = Buffer.from(osc, 'utf8')
        let offset = 0
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset)
          if (written <= 0) throw new Error('terminal write made no progress')
          offset += written
        }
      } finally {
        closeSync(fd)
      }
      toolText(id, `primary working directory reported: ${path}`)
    } catch {
      toolError(id, 'working-directory report failed: no daemon-backed pane or controlling terminal accepted it')
    }
    return
  }

  const pane = paneIdentity()
  const token = paneToken()
  if (!pane || !token) {
    replyErr(id, -32602, `"${def.name}" is unavailable: this MCP session has no pane credentials`)
    return
  }
  try {
    const m = await callDaemon(
      { t: 'cwd-report', id: pane, token, cwd: args.path, observedAt: Date.now() },
      ['cwd-reported']
    )
    if (m.t === 'error') {
      toolError(id, `working-directory report rejected (${m.reason || 'error'})`)
      return
    }
    toolText(id, `primary working directory reported: ${m.cwd}`)
  } catch (e) {
    if (e.rpc) replyErr(id, -32000, String(e.message || e))
    else toolError(id, String(e.message || e))
  }
}

// ── The write tools (8/03): granted-only, live-checked, attributable ─────────

/** Tool-specific arg rules the flat schema can't express. */
function writeArgsProblem(def, args) {
  if (def.name === 'release_files' && !args.pattern && args.all !== true) {
    return 'one of "pattern" or all=true is required'
  }
  if (def.name === 'update_card') {
    const mutating = ['column', 'note', 'title', 'priority', 'labels', 'blocked', 'blockedReason', 'before']
    if (!mutating.some((k) => args[k] !== undefined)) {
      return `at least one of ${mutating.map((k) => `"${k}"`).join(', ')} is required`
    }
  }
  return null
}

/** Dispatch one GRANTED write to its existing upstream verb. Returns
 *  { text, receipt? } or { error } (tool error, CLI wording). Throws e.rpc for
 *  connection-level failures. NO new daemon capability: same verbs, same
 *  allowlists, same caps as the `mogging` CLI. */
async function dispatchWrite(def, args, by) {
  switch (def.verb) {
    case 'input': {
      // The CLI's send, exactly: pane checked against the welcome snapshot,
      // then input + pipelined ping — pong proves the daemon processed it.
      let sess
      try {
        sess = await connectEndpoint(daemonEndpointFile())
      } catch (e) {
        const err = new Error(
          e.code === 'auth'
            ? 'the MoggingLabs daemon refused the connection (auth)'
            : 'the MoggingLabs daemon is not running — open the app (or a pane), or point MOGGING_DAEMON_ENDPOINT at its endpoint file'
        )
        err.rpc = true
        throw err
      }
      try {
        const panes = sess.welcome.panes ?? []
        if (!panes.some((p) => String(p.id) === String(args.pane))) return { error: `unknown pane ${args.pane}` }
        const reply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const err = new Error('the MoggingLabs daemon did not respond in time')
            err.rpc = true
            reject(err)
          }, 5000)
          sess.onMessage((m) => {
            if (m.t === 'pong' || m.t === 'error') {
              clearTimeout(timer)
              resolve(m)
            }
          })
          sess.send({ t: 'input', id: String(args.pane), data: args.text + (args.noEnter ? '' : '\r') })
          sess.send({ t: 'ping' })
        })
        if (reply.t !== 'pong') return { error: `send rejected (${reply.reason || 'error'})` }
        return { text: `sent to pane ${args.pane}`, receipt: { pane: String(args.pane) } }
      } finally {
        sess.close()
      }
    }
    case 'send-key': {
      const m = await callDaemon({ t: 'send-key', id: String(args.pane), key: args.key }, ['sent'])
      if (m.t === 'error') {
        return {
          error:
            m.reason === 'badkey'
              ? `unknown key "${args.key}" (allowed: enter, tab, escape, backspace, space, up, down, left, right, home, end, page-up, page-down, c-c, c-d, c-z, c-l, c-u, c-r)`
              : `unknown pane ${args.pane}`
        }
      }
      return { text: `key "${args.key}" sent to pane ${args.pane}`, receipt: { pane: String(args.pane) } }
    }
    case 'mail-send': {
      // Sender = pane identity, always (attributable); body capped daemon-side
      // at 16 KB exactly like `mogging mail send`. The pane token binds the sender
      // to `by` — the daemon refuses an unbound pane sender (badpaneauth).
      const m = await callDaemon({ t: 'mail-send', from: by, to: String(args.to), body: args.body, token: paneToken() }, ['mailed'])
      if (m.t === 'error') return { error: `mail rejected (${m.reason || 'error'})` }
      return {
        text: `mail #${m.id} sent`,
        receipt: args.to !== 'all' ? { pane: String(args.to) } : {}
      }
    }
    case 'claim': {
      const m = await callDaemon({ t: 'claim', pattern: args.pattern, from: by, token: paneToken() }, ['claimed', 'claim-denied'])
      if (m.t === 'claim-denied') return { error: `DENIED — overlaps "${m.pattern}" owned by pane ${m.ownerPaneId}` }
      if (m.t === 'error') return { error: `claim rejected (${m.reason || 'error'})` }
      return { text: `claim #${m.id} granted`, receipt: {} }
    }
    case 'release': {
      const m = await callDaemon({ t: 'release', pattern: args.pattern, all: args.all === true, from: by, token: paneToken() }, ['released'])
      if (m.t === 'error') return { error: `release rejected (${m.reason || 'error'})` }
      return { text: `released ${m.count}`, receipt: {} }
    }
    default: {
      // ADR 0018 step 09 (+ revision C's draft verbs): the memory writes ride
      // the same app endpoint and the same grant. Create/update/promote answer
      // the slug and the fileHash the next update will CAS against (the file is
      // indexed before this reply); discard answers the slug it deleted.
      if (def.verb === 'brain.memCreate' || def.verb === 'brain.memUpdate' || def.verb === 'brain.memPromote' || def.verb === 'brain.memDiscard') {
        const r = await callApp(def.verb, args)
        if (!r.ok) return { error: memoryWriteRefusalText(r) }
        if (def.verb === 'brain.memDiscard') return { text: JSON.stringify({ slug: r.slug, discarded: true }) }
        return { text: JSON.stringify({ slug: r.slug, fileHash: r.fileHash }) }
      }
      // ADR 0018 step 07: the brain's symbol writes ride the app endpoint like
      // the board's — main re-derives the grant (fail-closed), the engine holds
      // own-checkout scope + file CAS + sanity, the landing is atomic and
      // synchronously re-indexed. The success payload is the write's receipt to
      // the MODEL: the new generation, the landed node, and the newFileHash the
      // next edit will CAS against. No receipt frame — the trail is app-side.
      if (def.verb.startsWith('brain.')) {
        const r = await callApp(def.verb, args)
        if (!r.ok) return { error: brainWriteRefusalText(r) }
        return { text: JSON.stringify({ generation: r.generation, node: r.node ?? null, newFileHash: r.newFileHash }) }
      }
      // Board v2 writes all ride the app endpoint; main is the one writer
      // (CAS + claim rule + activity). Refusals come back verbatim and are
      // translated here into text a MODEL can act on — the fresh card rides
      // along on a conflict so the agent can retry without another read.
      if (!def.verb.startsWith('board.')) return { error: `unroutable write verb: ${def.verb}` }
      const r = await callApp(def.verb, args)
      if (!r.ok) {
        const cardState = r.card ? ` Current state: ${JSON.stringify(r.card)}` : ''
        switch (r.reason) {
          case 'unknown-card':
            return { error: `unknown card ${args.card ?? ''} (not on your project's board)` }
          case 'conflict':
            return { error: `refused — the card changed since your expectedRevision.${cardState}` }
          case 'claimed':
            return { error: `refused — pane ${r.owner ?? '?'} is working this card. Coordinate via mail_send, or pick another card.${cardState}` }
          case 'not-holder':
            return { error: `refused — your pane does not hold this card${r.owner != null ? ` (pane ${r.owner} does)` : ''}` }
          case 'invalid':
            return { error: 'refused — the write was invalid (empty title, unknown field value, or a bad "before" target)' }
          case 'forbidden':
            return { error: 'refused — this workspace has not granted board writes' }
          default:
            return { error: `card write failed: ${r.reason || 'error'}` }
        }
      }
      const createdId = def.verb === 'board.create' && r.card ? String(r.card.id) : undefined
      const DONE_TEXT = {
        'board.create': () => `card ${createdId} created`,
        'board.update': () => `card ${args.card} updated`,
        'board.claim': () => `card ${args.card} claimed by your pane`,
        'board.release': () => `card ${args.card} released`,
        'board.comment': () => `comment added to card ${args.card}`,
        'board.archive': () => `card ${args.card} archived`
      }
      const text = (DONE_TEXT[def.verb] || (() => `card write ok`))()
      const body = r.card ? `${text}\n${JSON.stringify(r.card)}` : text
      return {
        text: body,
        receipt: {
          card: String(createdId ?? args.card ?? ''),
          ...(r.pane != null ? { pane: String(r.pane) } : {})
        }
      }
    }
  }
}

async function handleWriteCall(id, def, args) {
  const by = paneIdentity()
  if (!by) {
    // Human sessions get no write tools, period — not listed, and a direct
    // call is a spec error (humans drive panes directly).
    replyErr(id, -32602, `"${def.name}" is unavailable: write tools exist only inside a pane session`)
    return
  }
  // LIVE grant re-check per call — a revoke lands mid-session even if the
  // client ignored list_changed. Unverifiable (app down) is a clean refusal.
  let live
  try {
    const r = await callApp('grant.get', {})
    live = applyGrantSet(r.ok && Array.isArray(r.writeTools) ? r.writeTools : [], true)
  } catch {
    replyErr(id, -32000, 'cannot verify the write grant — the MoggingLabs app is not running')
    return
  }
  if (!live.has(def.name)) {
    replyErr(
      id,
      -32602,
      `"${def.name}" requires the workspace integrations grant — write tools are OFF for this workspace (default). The human grants them in the app.`
    )
    return
  }
  const extra = writeArgsProblem(def, args)
  if (extra) {
    replyErr(id, -32602, `${def.name}: ${extra}`)
    return
  }
  try {
    const done = await dispatchWrite(def, args, by)
    if (done.error) {
      toolError(id, done.error)
      return
    }
    toolText(id, done.text)
    // The receipt: attention on the target + the trail, app-side. Fire and
    // forget — tool NAME and pane ids only, never args or bodies (ADR 0005).
    if (done.receipt && appSession) appSession.send({ t: 'receipt', tool: def.name, ...done.receipt })
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
  const problem = argsProblem(def, args)
  if (problem) {
    replyErr(id, -32602, `${name}: ${problem}`)
    return
  }
  if (def.access === 'self') await handleSelfCall(id, def, args)
  else if (def.access === 'write') await handleWriteCall(id, def, args)
  else if (def.family === 'browser') await handleBrowserCall(id, def, args)
  else if (def.family === 'brain') await handleBrainCall(id, def, args)
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
      // Resolve the session's grant BEFORE replying (bounded) so the first
      // tools/list is already right; later flips ride list_changed.
      void (async () => {
        await Promise.race([refreshGrant(false), new Promise((r) => setTimeout(r, 2000))]).catch(() => {})
        reply(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mogging', version: VERSION },
          instructions: CWD_INSTRUCTIONS
        })
      })()
    } else if (method === 'tools/list') {
      reply(id, {
        tools: servedTools().map((t) => ({
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
