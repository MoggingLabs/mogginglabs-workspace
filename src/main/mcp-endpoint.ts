import net from 'node:net'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'
import { agentAct, agentControlDebug } from './browser-dock'
import { handleUsageCall } from './usage'
import { getSettingsStore } from './app-settings'
import { onIntegrationsGrantChanged, resolveGrantedWriteTools, workspaceIdForPane } from './integrations'
import { connectionUpstream } from './connections'
import { mcpFetch } from '@backend/features/integrations'
import { getDaemonClient } from './daemon-relay'
import { runtimeDir as clientRuntimeDir } from './daemon-client'
import { recordTrail } from './trail'
import { MCP_BROWSER_TOOL_NAMES, type BrowserAgentVerb, type BrowserAgentVerbName } from '@contracts'
import { applyCardPatch, boardForPane, commentCard, createCard } from './board'

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

// This is TypeScript: import the contract, never restate it. A hardcoded 3 here (while the daemon
// moved to v4) would have put browser-control.json in a directory the MCP server never reads —
// silently, since "no endpoint file" is indistinguishable from "the app is not running".
const PROTOCOL = DAEMON_PROTOCOL_VERSION

/** A rejected dispatch must still answer the bridge, or the agent's tools/call hangs forever
 *  (bin/mogging-mcp.mjs + mogging-connection.mjs both wait unbounded for a `result` frame).
 *  A `.catch` that turns the rejection into a truthful failure result is what closes that hang. */
function rpcFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.trim() ? msg.slice(0, 200) : 'the request failed'
}

// ONE resolver (daemon-client's) instead of a third restatement of the base+channel
// derivation. The channel segment matters here for the same reason it does there: the
// browser-control endpoint belongs to ONE app — an MCP client wired to dev must never
// steer an installed release's dock, nor vice versa. This writer additionally ensures
// the dir exists (the client-side resolver is read-only by design).
function runtimeDir(): string {
  const dir = clientRuntimeDir()
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
      return { verb: 'scroll', dy: n('dy'), to: args.to === 'y' ? 'y' : undefined }
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
    case 'browser_tab_list':
      return { verb: 'tab_list' }
    case 'browser_tab_new':
      return { verb: 'tab_new', target: s('url') }
    case 'browser_tab_select':
      return { verb: 'tab_select', target: s('tab') }
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
    case 'create_card':
      return `MCP: card created by pane ${by}`
    case 'claim_card':
      return `MCP: card claimed by pane ${by}`
    case 'release_card':
      return `MCP: card released by pane ${by}`
    case 'comment_card':
      return `MCP: card comment by pane ${by}`
    case 'archive_card':
      return `MCP: card archived by pane ${by}`
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
    const bound = getSettingsStore()?.getCard(card)?.paneId
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

// ── Board v2 over the agent wire (M2): scoped reads + granted CRUD ────────────

type BoardRpcReply = { ok: boolean } & Record<string, unknown>

/** board.<verb> -> the write-tool name whose grant covers it. ONE map — the
 *  catalog's rows point back at these verbs, so the two cannot drift far. */
const BOARD_WRITE_TOOL: Record<string, string> = {
  'board.update': 'update_card',
  'board.create': 'create_card',
  'board.claim': 'claim_card',
  'board.release': 'release_card',
  'board.comment': 'comment_card',
  'board.archive': 'archive_card'
}

function handleBoardRead(name: string, args: Record<string, unknown>, boundPane: string | undefined): BoardRpcReply {
  const store = getSettingsStore()
  if (!store) return { ok: false, reason: 'the board store is unavailable' }
  if (name === 'board.get') {
    const card = store.getCard(String(args.card ?? ''))
    if (!card) return { ok: false, reason: 'unknown-card' }
    if (boundPane) {
      const board = boardForPane(boundPane)
      // A pane reads its OWN project's board, nothing else — same scope as list.
      if (!board || card.boardId !== board.id) return { ok: false, reason: 'unknown-card' }
    }
    return { ok: true, card, activity: store.listBoardActivity(card.id, 20) }
  }
  if (boundPane) {
    const board = boardForPane(boundPane)
    if (!board) return { ok: true, board: null, cards: [] }
    return {
      ok: true,
      board: { id: board.id, name: board.name, repoRef: board.repoRef },
      cards: store.listCards(board.id)
    }
  }
  // Paneless (human/app) session: the all-boards overview.
  return { ok: true, board: null, cards: store.listAllCards() }
}

/** Labels ride the wire as one comma-separated string (catalog schemas are
 *  primitive-only); the writer's sanitizer owns caps/dedupe. */
const splitLabels = (v: unknown): string[] | undefined =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined

function handleBoardWrite(name: string, args: Record<string, unknown>, boundPane: string | undefined): BoardRpcReply {
  const tool = BOARD_WRITE_TOOL[name]
  if (!tool) return { ok: false, reason: 'unknown-tool' }
  // Defense in depth: the server already filters by grant; the endpoint
  // re-derives it and fails closed (same as the old board.save).
  if (!boundPane || !resolveGrantedWriteTools(boundPane).writeTools.includes(tool)) {
    return { ok: false, reason: 'forbidden' }
  }
  const store = getSettingsStore()
  if (!store) return { ok: false, reason: 'the board store is unavailable' }
  const board = boardForPane(boundPane)
  if (!board) return { ok: false, reason: 'forbidden' }
  const actor = `pane ${boundPane}`

  if (name === 'board.create') {
    const card = createCard(
      {
        boardId: board.id,
        title: args.title,
        notes: args.note,
        lane: args.column,
        priority: args.priority,
        labels: splitLabels(args.labels),
        actor
      },
      actor
    )
    return card ? { ok: true, card } : { ok: false, reason: 'invalid' }
  }

  const card = store.getCard(String(args.card ?? ''))
  if (!card || card.boardId !== board.id) return { ok: false, reason: 'unknown-card' }

  if (name === 'board.comment') {
    const done = commentCard(card.id, args.body, actor)
    return done.ok ? { ok: true, pane: card.paneId ?? undefined } : done
  }
  if (name === 'board.claim') {
    const result = applyCardPatch(
      card.id,
      { paneId: Number(boundPane), workspaceId: workspaceIdForPane(boundPane) ?? null },
      { actor, enforceClaimFor: boundPane }
    )
    if (!result.ok) return { ok: false, reason: result.reason, card: result.card, owner: result.card?.paneId ?? undefined }
    return { ok: true, card: result.card }
  }
  if (name === 'board.release') {
    if (String(card.paneId ?? '') !== boundPane) return { ok: false, reason: 'not-holder', owner: card.paneId ?? undefined }
    const result = applyCardPatch(card.id, { paneId: null, workspaceId: null }, { actor })
    return result.ok ? { ok: true, card: result.card } : { ok: false, reason: result.reason }
  }
  if (name === 'board.archive') {
    const result = applyCardPatch(card.id, { archivedAt: Date.now() }, { actor, enforceClaimFor: boundPane })
    if (!result.ok) return { ok: false, reason: result.reason, owner: result.card?.paneId ?? undefined }
    return { ok: true, card: result.card, pane: card.paneId ?? undefined }
  }
  // board.update — the widened update_card: field patch + optional CAS.
  const patch: Record<string, unknown> = {}
  if (args.column !== undefined) patch.lane = args.column
  if (args.note !== undefined) patch.notes = args.note
  if (args.title !== undefined) patch.title = args.title
  if (args.priority !== undefined) patch.priority = args.priority
  if (args.labels !== undefined) patch.labels = splitLabels(args.labels)
  if (args.blocked !== undefined) patch.blocked = args.blocked
  if (args.blockedReason !== undefined) patch.blockedReason = args.blockedReason
  if (args.before !== undefined) patch.beforeId = args.before
  const result = applyCardPatch(card.id, patch, {
    actor,
    enforceClaimFor: boundPane,
    expectedRevision: typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined
  })
  if (!result.ok) {
    return { ok: false, reason: result.reason, card: result.card, owner: result.card?.paneId ?? undefined }
  }
  return { ok: true, card: result.card, pane: result.card.paneId ?? undefined }
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
            void handleUsageCall(msg.name, msg.args ?? {})
              .then((r) => sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n'))
              .catch((e) => sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: rpcFailure(e) }) + '\n'))
            continue
          }
          // 8/02 → Board v2: the board lives app-side. Reads are pane-SCOPED —
          // a pane sees its own workspace's project board; a paneless (human)
          // session gets the all-boards overview. Card text is USER CONTENT:
          // it rides this authed socket to the CALLING MODEL only (same class
          // as capture — never telemetry, notify, or logs, ADR 0005).
          if (msg.name === 'board.list' || msg.name === 'board.get') {
            sock.write(JSON.stringify({ t: 'result', id, ...handleBoardRead(msg.name, msg.args ?? {}, boundPane) }) + '\n')
            continue
          }
          // Board v2 writes: full CRUD behind the SAME per-workspace grant, all
          // funneled through main's one writer (CAS + claim rule + activity).
          // Replies carry the card's bound pane so receipts can land on it.
          if (msg.name.startsWith('board.')) {
            sock.write(JSON.stringify({ t: 'result', id, ...handleBoardWrite(msg.name, msg.args ?? {}, boundPane) }) + '\n')
            continue
          }
          // ADR 0014: the connection proxy. A bridge asks us to speak to a service
          // the APP is connected to; we attach the token it never gets to see.
          if (msg.name === 'connection.rpc') {
            const args = msg.args ?? {}
            void handleConnectionRpc(String(args.connection ?? ''), args.payload, mcpSessions)
              .then((r) => sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n'))
              .catch((e) => sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: rpcFailure(e) }) + '\n'))
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
          void agentAct(verb, { pane: boundPane })
            .then((r) => sock.write(JSON.stringify({ t: 'result', id, ...r }) + '\n'))
            .catch((e) => sock.write(JSON.stringify({ t: 'result', id, ok: false, reason: rpcFailure(e) }) + '\n'))
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
