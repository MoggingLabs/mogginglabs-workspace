import net from 'node:net'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION, channelFromEnv, runtimeSegment } from '@contracts'
import { agentAct, agentControlDebug } from './browser-dock'
import { handleUsageCall } from './usage'
import { getSettingsStore } from './app-settings'
import { onIntegrationsGrantChanged, resolveGrantedWriteTools } from './integrations'
import { connectionUpstream } from './connections'
import { mcpFetch } from '@backend/features/integrations'
import { getDaemonClient } from './daemon-relay'
import { recordTrail } from './trail'
import {
  BOARD_LANES,
  MCP_BROWSER_TOOL_NAMES,
  type BoardCard,
  type BrowserAgentVerb,
  type BrowserAgentVerbName
} from '@contracts'

/**
 * The agent-control transport (Phase-6/05b). Main opens a token-authed LOCAL
 * IPC endpoint (unix socket / named pipe — same class as the daemon's, ADR
 * 0006; nothing new on TCP) and writes a 0600 endpoint file. The first-party
 * MCP server (`bin/mogging-mcp.mjs`) connects here and forwards `tools/call`
 * to `agentAct` — so an agent CLI in a pane reaches the browser tools without
 * any daemon-protocol change (no daemon change rode this feature).
 *
 * Wire: newline-delimited JSON. `{ t:'hello', token }` -> `{ t:'welcome' }` or
 * an auth error; then `{ t:'call', id, name, args }` -> `{ t:'result', id, ... }`.
 * Consent is enforced downstream by agentAct (per-workspace, default OFF).
 */

const APP = 'MoggingLabs'
// This is TypeScript: import the contract, never restate it. A hardcoded 3 here (while the daemon
// moved to v4) would have put browser-control.json in a directory the MCP server never reads —
// silently, since "no endpoint file" is indistinguishable from "the app is not running".
const PROTOCOL = DAEMON_PROTOCOL_VERSION

function runtimeDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), 'Library', 'Application Support')
  // Channel segment (run/v4 vs run/dev-v4): the browser-control endpoint belongs to ONE app —
  // an MCP client wired to dev must never steer an installed release's dock, nor vice versa.
  const dir = path.join(base, APP, 'run', runtimeSegment(channelFromEnv()))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const endpointFile = (): string => path.join(runtimeDir(), 'browser-control.json')
const socketAddress = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\mogging-browser-${process.pid}`
    : path.join(runtimeDir(), `browser-${process.pid}.sock`)

/** MCP tool name -> agentAct verb + arg mapping. The ONE place the two shapes meet. */
function toVerb(name: string, args: Record<string, unknown>): BrowserAgentVerb | null {
  const s = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  const n = (k: string): number | undefined => (typeof args[k] === 'number' ? (args[k] as number) : undefined)
  switch (name) {
    case 'browser_navigate':
      return { verb: 'navigate', target: s('url') }
    case 'browser_back':
      return { verb: 'back' }
    case 'browser_forward':
      return { verb: 'forward' }
    case 'browser_reload':
      return { verb: 'reload' }
    case 'browser_snapshot':
      return { verb: 'snapshot' }
    case 'browser_screenshot':
      return { verb: 'screenshot' }
    case 'browser_click':
      return { verb: 'click', target: s('ref') }
    case 'browser_type':
      return { verb: 'type', target: s('ref'), value: s('text') }
    case 'browser_scroll':
      return { verb: 'scroll', dy: n('dy') }
    case 'browser_select':
      return { verb: 'select', target: s('ref'), value: s('value') }
    case 'browser_eval':
      return { verb: 'eval', target: s('js') }
    case 'browser_console':
      return { verb: 'console', n: n('tail') }
    case 'browser_network_failures':
      return { verb: 'network_failures', n: n('tail') }
    case 'browser_wait_for':
      return { verb: 'wait_for', target: s('selector'), n: n('timeoutMs') }
    default:
      return null
  }
}

// 8/02: the names come from the ONE catalog (@contracts/integrations) — the
// hand-written list died with the server's; `toVerb` above is checked against
// it at startup so the two can never drift silently.
export const MCP_TOOL_NAMES: string[] = [...MCP_BROWSER_TOOL_NAMES]

let server: net.Server | null = null
let token = ''
const authedSocks = new Set<net.Socket>()

/** One wording source for receipt copy — tool name + acting pane, nothing else. */
function receiptCopy(tool: string, by: string): string {
  switch (tool) {
    case 'send_to_pane':
      return `MCP: sent by pane ${by}`
    case 'send_key':
      return `MCP: key press by pane ${by}`
    case 'mail_send':
      return `MCP: mail from pane ${by}`
    case 'update_card':
      return `MCP: card updated by pane ${by}`
    default:
      return `MCP: ${tool} by pane ${by}`
  }
}

/**
 * The connection proxy (ADR 0014) — the app IS the MCP client.
 *
 * `bin/mogging-connection.mjs` forwards an agent's JSON-RPC frame here verbatim;
 * we attach the OAuth token and call the real server. The token is decrypted
 * inside `connectionUpstream` and dies with this stack frame — it is never
 * written to a config, a log, or the socket that asked for it.
 *
 * `sessions` is PER-SOCKET, and must be: a streamable-HTTP server hands out an
 * `mcp-session-id` at initialize and rejects later calls that omit it. One bridge
 * process is one agent's session, so one socket is the right lifetime for it —
 * a map shared across bridges would cross two agents' sessions into one.
 */
async function handleConnectionRpc(
  connection: string,
  payload: unknown,
  sessions: Map<string, string>
): Promise<{ ok: boolean; payload?: unknown; reason?: string }> {
  if (!/^[a-z0-9_-]{1,64}$/i.test(connection)) return { ok: false, reason: 'unknown connection' }
  const upstream = await connectionUpstream(connection)
  if (!upstream) {
    return {
      ok: false,
      reason: `The ${connection} connection is not connected in MoggingLabs Workspace — open Settings › Integrations and connect it.`
    }
  }
  const res = await mcpFetch(upstream.url, payload, {
    token: upstream.token,
    authScheme: upstream.authScheme,
    sessionId: sessions.get(connection)
  })
  if (!res.ok) {
    // Streamable HTTP: 404 with a session id means the SERVER expired the session
    // (spec: the client must start over with a new initialize). Holding the stale id
    // made every later call 404 forever; dropping it lets the agent's own re-initialize
    // mint a fresh session on the next round trip.
    if (res.status === 404 && sessions.has(connection)) sessions.delete(connection)
    return { ok: false, reason: res.reason }
  }
  if (res.sessionId) sessions.set(connection, res.sessionId)
  return { ok: true, payload: res.result }
}

/** A granted write's receipt: attention on the target pane + the trail stub.
 *  Every write is attributable — `by` is the acting pane, always present. */
function handleReceipt(msg: Record<string, unknown>, boundPane: string | undefined): void {
  const tool = String(msg.tool ?? '')
  const by = boundPane ?? ''
  if (!tool || !by) return // anonymous writes don't exist
  const card = typeof msg.card === 'string' ? msg.card : undefined
  let targetPane = typeof msg.pane === 'string' && msg.pane ? msg.pane : ''
  if (!targetPane && card) {
    const bound = getSettingsStore()?.listBoard().find((c) => c.id === card)?.paneId
    if (bound != null) targetPane = String(bound)
  }
  if (targetPane) getDaemonClient()?.notify(targetPane, 'attention', receiptCopy(tool, by))
  recordTrail({
    ts: Date.now(),
    source: 'mcp',
    workspaceId: resolveGrantedWriteTools(by).workspaceId ?? '',
    pane: by,
    verb: tool,
    target: targetPane ? `pane ${targetPane}` : card ? `card ${card}` : 'fleet',
    outcome: 'ok'
  })
}

export function startMcpEndpoint(): void {
  if (server) return
  // Catalog↔dispatch drift check: every browser tool the catalog names must
  // map to an agentAct verb here. Fails the boot, not a tools/call at 2 AM.
  for (const n of MCP_BROWSER_TOOL_NAMES) {
    if (!toVerb(n, {})) throw new Error(`mcp-endpoint: catalog browser tool "${n}" has no verb mapping`)
  }
  token = randomBytes(24).toString('hex')
  const address = socketAddress()
  try {
    if (process.platform !== 'win32' && fs.existsSync(address)) fs.unlinkSync(address)
  } catch {
    /* ignore */
  }

  server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let buf = ''
    let authed = false
    let authPending = false
    let boundPane: string | undefined
    // One bridge process = one agent's MCP session. Scoped to the socket so it
    // dies with the agent, and so two agents never share a server session id.
    const mcpSessions = new Map<string, string>()
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg: { t?: string; token?: string; paneToken?: string; id?: number; name?: string; args?: Record<string, unknown>; pane?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.t === 'hello') {
          if (msg.token !== token || authPending || authed) {
            sock.write(JSON.stringify({ t: 'error', reason: 'auth' }) + '\n')
            sock.destroy()
            continue
          }
          const wantsPane = typeof msg.pane === 'string' || typeof msg.paneToken === 'string'
          if (!wantsPane) {
            authed = true // human/read-only app client; pane-scoped verbs still fail closed
            authedSocks.add(sock)
            sock.write(JSON.stringify({ t: 'welcome', tools: MCP_TOOL_NAMES, paneBound: false }) + '\n')
            continue
          }
          if (typeof msg.pane !== 'string' || !msg.pane || typeof msg.paneToken !== 'string' || !msg.paneToken) {
            sock.write(JSON.stringify({ t: 'error', reason: 'auth' }) + '\n')
            sock.destroy()
            continue
          }
          authPending = true
          const pane = msg.pane
          const verifier = getDaemonClient()
          void (verifier ? verifier.verifyPaneToken(pane, msg.paneToken) : Promise.resolve(false)).then((valid) => {
            authPending = false
            if (sock.destroyed) return
            if (!valid) {
              sock.write(JSON.stringify({ t: 'error', reason: 'auth' }) + '\n')
              sock.destroy()
              return
            }
            boundPane = pane
            authed = true
            authedSocks.add(sock)
            sock.write(JSON.stringify({ t: 'welcome', tools: MCP_TOOL_NAMES, paneBound: true }) + '\n')
          })
          continue
        }
        if (!authed) {
          sock.destroy()
          return
        }
        // 8/03: a receipt for a granted write — fire-and-forget from the
        // server. Lands a subtle attention event on the TARGET pane's header
        // (the house notify path) and feeds the trail stub. Tool NAME + pane
        // ids only — args/bodies never ride a receipt (ADR 0005).
        if (msg.t === 'receipt') {
          if (boundPane) handleReceipt(msg as unknown as Record<string, unknown>, boundPane)
          continue
        }
        if (msg.t === 'call' && typeof msg.id === 'number' && typeof msg.name === 'string') {
          const id = msg.id
          // 7/11: `usage.*` request types for the mogging CLI — SAME frame,
          // SAME handshake, no new listener (no daemon change rode this).
          // Deliberately NOT in the welcome tools list: usage verbs are for
          // the CLI, never advertised to agents through the MCP server.
          if (msg.name.startsWith('usage.')) {
            void handleUsageCall(msg.name, msg.args ?? {}).then((r) => {
              sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n')
            })
            continue
          }
          // 8/02: the board lives app-side — `board.list` serves the control
          // read `list_board`. Card text is USER CONTENT: it rides this authed
          // socket to the CALLING MODEL only (same class as capture — never
          // telemetry, notify, or logs, ADR 0005).
          if (msg.name === 'board.list') {
            sock.write(JSON.stringify({ t: 'result', id, ok: true, cards: getSettingsStore()?.listBoard() ?? [] }) + '\n')
            continue
          }
          // 8/03: `update_card`'s upstream — patch lane/notes on an EXISTING
          // card (the board:save capability, no new verbs). Reply carries the
          // card's bound pane so the server's receipt can land on it.
          if (msg.name === 'board.save') {
            if (!boundPane || !resolveGrantedWriteTools(boundPane).writeTools.includes('update_card')) {
              sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: 'forbidden' }) + '\n')
              continue
            }
            const args = msg.args ?? {}
            const store = getSettingsStore()
            const card = store?.listBoard().find((c) => c.id === String(args.card ?? ''))
            if (!store || !card) {
              sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: 'unknown-card' }) + '\n')
              continue
            }
            if (typeof args.column === 'string') {
              if (!(BOARD_LANES as readonly string[]).includes(args.column)) {
                sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: 'badlane' }) + '\n')
                continue
              }
              card.lane = args.column as BoardCard['lane']
            }
            if (typeof args.note === 'string') card.notes = args.note.slice(0, 10000)
            card.updatedAt = Date.now()
            store.saveBoardCard(card)
            sock.write(JSON.stringify({ t: 'result', id, ok: true, pane: card.paneId ?? undefined }) + '\n')
            continue
          }
          // ADR 0014: the connection proxy. A bridge asks us to speak to a service
          // the APP is connected to; we attach the token it never gets to see.
          if (msg.name === 'connection.rpc') {
            const args = msg.args ?? {}
            void handleConnectionRpc(String(args.connection ?? ''), args.payload, mcpSessions).then((r) => {
              sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n')
            })
            continue
          }
          // 8/03: the grant wire. `grant.get` resolves pane -> workspace ->
          // granted write-tool NAMES (fail-closed); the server filters its
          // catalog by this list and re-checks it live per write call.
          if (msg.name === 'grant.get') {
            const res = boundPane ? resolveGrantedWriteTools(boundPane) : { writeTools: [] }
            sock.write(JSON.stringify({ t: 'result', id, ok: true, ...res }) + '\n')
            continue
          }
          const verb = toVerb(msg.name, msg.args ?? {})
          if (!verb) {
            sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: 'unknown-tool' }) + '\n')
            continue
          }
          if (!boundPane) {
            sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: 'nopane' }) + '\n')
            continue
          }
          // 8/07c: carry the calling pane so the browser verb drives the
          // AGENT'S OWN workspace's browser, not whatever's in the foreground.
          void agentAct(verb, { pane: boundPane }).then((r) => {
            sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n')
          })
        }
      }
    })
    sock.on('error', () => sock.destroy())
    sock.on('close', () => authedSocks.delete(sock))
  })

  // A grant flip anywhere -> every live server session re-resolves (and emits
  // notifications/tools/list_changed to its agent when its set changed).
  onIntegrationsGrantChanged(() => {
    for (const s of authedSocks) {
      try {
        s.write(JSON.stringify({ t: 'grantChanged' }) + '\n')
      } catch {
        /* peer gone; close handler cleans up */
      }
    }
  })

  server.on('error', () => {
    /* endpoint best-effort; the dock chrome still works without agent control */
  })
  server.listen(address, () => {
    try {
      fs.writeFileSync(endpointFile(), JSON.stringify({ version: PROTOCOL, address, token }), { mode: 0o600 })
    } catch {
      /* ignore */
    }
  })
}

export function stopMcpEndpoint(): void {
  try {
    server?.close()
  } catch {
    /* ignore */
  }
  server = null
  try {
    fs.unlinkSync(endpointFile())
  } catch {
    /* already gone */
  }
}

/** Smoke-only: the endpoint file path + whether it's live. */
export function mcpEndpointDebug(): { file: string; live: boolean; consent: boolean } {
  return { file: endpointFile(), live: !!server, consent: agentControlDebug().allowed }
}

// Keep the verb-name type referenced so the tool map can't silently drift.
export type { BrowserAgentVerbName }
