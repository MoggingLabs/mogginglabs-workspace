// Socket/named-pipe server: framing, the version + auth-token handshake (unauthenticated
// connections are dropped within seconds), and per-connection pane subscriptions. (ADR 0006.)
import * as net from 'node:net'
import {
  createLineFramer,
  encodeMessage,
  keyToBytes,
  DAEMON_PROTOCOL_VERSION,
  normalizeRemoteConnection
} from '@contracts'
import type { ClientIdentity, ClientMessage, ServerMessage, ReviewSnapshot } from '@contracts'
import { ptyEmulation } from '@backend/platform/pty-host'
import { normalizeRemotePaneCwd } from '@backend/features/agent-state'
import type { SessionManager, PaneSubscriber, PaneSession } from './session'
import { log } from './lifecycle'

export interface TransportHooks {
  onActivity(): void
  onClientCountChange(delta: number): void
  /** Terminate via the daemon's GRACEFUL shutdown (persist, clear endpoint, release lock).
   *  A bare process.exit here would drop the coalesced persist — a pane killed within the
   *  500ms window would resurrect (and type its resume) on the next start — and would
   *  leave a stale lock/endpoint pointing at a dead pid. */
  onShutdown(code: number): void
}

const OID = /^[0-9a-f]{40,64}$/i
const refShape = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._/-]+$/.test(value)
const validReviewSnapshot = (value: unknown): value is ReviewSnapshot => {
  const s = value as Partial<ReviewSnapshot> | null
  return !!s &&
    typeof s.repoId === 'string' && s.repoId.length > 0 && s.repoId.length <= 2048 &&
    refShape(s.branch) && refShape(s.base) &&
    typeof s.head === 'string' && OID.test(s.head) &&
    typeof s.baseHead === 'string' && OID.test(s.baseHead) &&
    typeof s.mergeBase === 'string' && OID.test(s.mergeBase)
}
const approvalKey = (repoId: string, branch: string): string => `${repoId}\0${branch}`

/** The self-reported identity from `hello`, sanitized into one short log label. Diagnosis
 *  only (never authorization): "shutdown requested by client" with no way to say WHICH
 *  client is what made a night of six daemon retires an archaeology project. */
function describeClient(raw: ClientIdentity | undefined): string {
  const pid = typeof raw?.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0
  const kind = typeof raw?.kind === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(raw.kind) ? raw.kind : ''
  if (!pid && !kind) return 'unidentified client'
  return `${kind || 'client'}${pid ? ` pid ${pid}` : ''}`
}

export function createServer(sessions: SessionManager, token: string, hooks: TransportHooks): net.Server {
  // Ownership-ledger pushes (4/02): every authed client gets a fresh `owners` on any
  // change (claim, release, pane exit) — the UI chips stay live with zero polling.
  const authedClients = new Set<(m: ServerMessage) => void>()
  sessions.ledger.onChange = () => {
    const msg: ServerMessage = { t: 'owners', claims: sessions.ledger.owners() }
    for (const push of authedClients) push(msg)
  }
  // Reviewer-gate pushes (4/03 polish): approvals changes reach every client too —
  // the board's ✓-chips stay live with zero polling.
  const pushApprovals = (): void => {
    const msg: ServerMessage = { t: 'approvals', list: [...sessions.approvals.values()] }
    for (const push of authedClients) push(msg)
  }

  // Failure-injection seam for the HEARTBEAT gate (same shape as MOGGING_DAEMON_SPAWN_DELAY_MS
  // below): ignore `ping` for the first N ms of this daemon's life, so a gate can stand up a
  // daemon that is provably ALIVE (welcome, spawn, data all work) yet silent to the client's
  // liveness probe — the exact wedge the heartbeat exists to detect. Production has no delay.
  const pingMuteUntil =
    Date.now() + Math.min(30_000, Math.max(0, Number(process.env.MOGGING_DAEMON_PING_MUTE_MS) || 0))

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let authed = false
    let who = 'unidentified client' // from hello's optional identity — log label only, never authz
    // One entry per pane id THIS connection follows — holding the exact SESSION the sub is
    // bound to, not just the sub. Pane ids are reused (a split takes the lowest free slot),
    // so the session reference is what distinguishes generations: an id-keyed guard alone
    // made a reused id's new session start with ZERO subscribers (its shell ran, its
    // scrollback grew, but not one byte reached the app — a terminal that opens empty).
    const subscriptions = new Map<string, { sub: PaneSubscriber; session: PaneSession }>()
    const send = (m: ServerMessage): void => {
      try {
        sock.write(encodeMessage(m))
      } catch {
        /* peer went away */
      }
    }
    const authTimer = setTimeout(() => {
      if (!authed) sock.destroy()
    }, 3000)

    /** Bind this connection to pane `id`'s CURRENT session. Idempotent for the same
     *  generation; a NEW generation gets a fresh, gen-stamped subscriber and the old
     *  generation is explicitly unbound — its pty's late exit (the process dies async,
     *  after the kill) must never fan into this connection again, or it would print
     *  "[process exited]" into the reused id's brand-new pane. */
    function subscribe(id: string): void {
      const session = sessions.get(id)
      if (!session) return
      const prev = subscriptions.get(id)
      if (prev) {
        if (prev.session === session) {
          session.subscribe(prev.sub) // same generation — Set-idempotent re-bind
          return
        }
        prev.session.unsubscribe(prev.sub) // dead generation: silence it for good
      }
      // Every event this sub emits carries the generation it was bound to, so the client
      // can gate on (id, gen) even for messages already in flight when the id was reused.
      const gen = session.gen
      const sub: PaneSubscriber = {
        send: (d) => send({ t: 'data', id, gen, data: d }),
        exit: (c) => {
          // Self-cleanup: this generation is over. Only clear the entry if it still
          // belongs to this sub — a later generation may have replaced it already.
          if (subscriptions.get(id)?.sub === sub) subscriptions.delete(id)
          send({ t: 'exit', id, gen, code: c })
        },
        state: (st) => send({ t: 'state', id, gen, state: st }),
        cwd: (location) =>
          send({
            t: 'cwd',
            id,
            gen,
            cwd: location.cwd,
            rev: location.revision,
            source: location.source,
            locality: location.locality
          }),
        limit: () => send({ t: 'limit', id, gen }),
        agent: (agentId, cwd, sinceMs) => send({ t: 'agent', id, gen, agentId, cwd, sinceMs })
      }
      subscriptions.set(id, { sub, session })
      session.subscribe(sub)
    }

    /** Does the sender hold pane `from`'s own MOGGING_PANE_TOKEN? The same binding
     *  `approve` and `cwd-report` already demand, applied to every verb that ACTS AS a
     *  pane: ids are public and the endpoint file is readable by every pane, so a bare
     *  `from` is a claim, not a fact. Emits the refusal itself; callers just break. */
    function boundToPane(verb: string, from: string, token: unknown): boolean {
      const pane = sessions.get(from)
      if (pane && typeof token === 'string' && token && token === pane.paneToken) return true
      log(`${verb} REFUSED: sender is not bound to pane ${from}`)
      send({ t: 'error', reason: 'badpaneauth' })
      return false
    }

    function handle(m: ClientMessage): void {
      switch (m.t) {
        case 'spawn': {
          const rawRemote = m.spec?.remote
          const remote = rawRemote ? normalizeRemoteConnection(rawRemote) : null
          if (
            rawRemote &&
            (!remote || (rawRemote.cwd !== undefined && !normalizeRemotePaneCwd(rawRemote.cwd)))
          ) {
            send({ t: 'error', reason: 'badremote', id: m.id })
            break
          }
          const spec = {
            ...(m.spec ?? {}),
            remote: remote
              ? {
                  ...remote,
                  shell: rawRemote?.shell,
                  cwd: rawRemote?.cwd === undefined ? undefined : normalizeRemotePaneCwd(rawRemote.cwd)!
                }
              : undefined
          }
          const spawn = (): void => {
            if (sock.destroyed) return
            const { pane, existed } = sessions.ensure(m.id, spec)
            // Reply FIRST, then bind: subscribe() synchronously replays state/cwd, and the
            // client gates every pane event on the generation it learns from `spawned` — a
            // replay arriving ahead of the gen would be dropped as stale. Same tick either
            // way, so no pty output can land between the scrollback snapshot and the bind.
            // The DAEMON owns the pty, so the daemon reports how it behaves — the app never guesses.
            send({
              t: 'spawned',
              id: m.id,
              gen: pane.gen,
              existing: existed,
              restored: existed && pane.restoredPristine,
              scrollback: pane.scrollback,
              pty: ptyEmulation()
            })
            subscribe(m.id)
          }
          // Failure-injection seam for the role-binding gate: production has no
          // delay, while the gate holds spawn past the retired 1.2 s timeout.
          const injectedDelay = Math.min(10000, Math.max(0, Number(process.env.MOGGING_DAEMON_SPAWN_DELAY_MS) || 0))
          if (injectedDelay) setTimeout(spawn, injectedDelay)
          else spawn()
          break
        }
        case 'attach': {
          const pane = sessions.get(m.id)
          if (!pane) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          // Reply before bind, same reason as `spawn`.
          send({ t: 'attached', id: m.id, gen: pane.gen, scrollback: pane.scrollback })
          subscribe(m.id)
          break
        }
        case 'input':
          sessions.get(m.id)?.write(m.data)
          break
        case 'resize':
          sessions.get(m.id)?.resize(m.cols, m.rows)
          break
        case 'kill':
          sessions.remove(m.id)
          break
        case 'notify': {
          // `mogging notify` (Phase-2/04): raise the target pane's attention. Only reachable
          // after the token handshake; payload is an event label (+ optional message) only.
          const target = m.id ? sessions.get(m.id) : undefined
          target?.applyNotify(m.event)
          send({ t: 'notified', id: m.id ?? '', ok: !!target })
          break
        }
        case 'cwd-report': {
          const pane = typeof m.id === 'string' && m.id ? sessions.get(m.id) : undefined
          if (!pane) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          if (typeof m.token !== 'string' || !m.token || m.token !== pane.paneToken) {
            log(`cwd-report REFUSED: sender is not bound to pane ${m.id}`)
            send({ t: 'error', reason: 'badpaneauth' })
            break
          }
          const result = pane.applyCwdReport(m.cwd, m.observedAt)
          if (!result.ok) {
            send({ t: 'error', reason: result.reason ?? 'badcwd' })
            break
          }
          send({
            t: 'cwd-reported',
            id: m.id,
            gen: pane.gen,
            cwd: result.current.cwd,
            rev: result.current.revision
          })
          break
        }
        case 'list':
          send({ t: 'panes', panes: sessions.list() })
          break
        case 'verify-pane': {
          const pane = typeof m.id === 'string' ? sessions.get(m.id) : undefined
          const valid =
            Number.isInteger(m.requestId) &&
            typeof m.token === 'string' &&
            !!m.token &&
            m.token === pane?.paneToken
          send({ t: 'pane-verified', requestId: m.requestId, id: String(m.id ?? ''), valid })
          break
        }
        case 'send-key': {
          // Control API (Phase-3/01): the key is a NAME resolved against the closed
          // allowlist HERE — a client can never inject arbitrary escape sequences.
          const pane = sessions.get(m.id)
          const bytes = keyToBytes(m.key)
          if (pane && bytes != null) {
            pane.write(bytes)
            send({ t: 'sent', id: m.id, ok: true })
          } else {
            send({ t: 'error', reason: bytes == null ? 'badkey' : 'nopane' })
          }
          break
        }
        case 'capture': {
          // Control API (Phase-3/01): scrollback tail to THIS caller only.
          const pane = sessions.get(m.id)
          if (pane) send({ t: 'captured', id: m.id, data: pane.captureTail(m.lastLines) })
          else send({ t: 'error', reason: 'nopane' })
          break
        }
        // ── Swarm mailbox + roles (Phase-4/01). Mail bodies are user/agent content:
        // they live in the in-memory ring only and go back to REQUESTING clients only
        // — never into a PTY, a log, telemetry, or disk. ──────────────────────────
        //
        // PANE senders prove themselves (see boundToPane): `from` alone let any agent
        // mail the swarm AS the reviewer. The '0' (human, outside any pane) sender has
        // no token and stays open — the boundary here is inter-AGENT trust, and any
        // client on this authed socket already speaks for the machine's user.
        case 'mail-send': {
          const from = typeof m.from === 'string' && m.from ? m.from : '0'
          if (from !== '0' && !boundToPane('mail-send', from, m.token)) break
          const to = typeof m.to === 'string' && m.to ? m.to : 'all'
          const id = typeof m.body === 'string' ? sessions.mailbox.send(from, to, m.body) : null
          if (id != null) send({ t: 'mailed', id })
          else send({ t: 'error', reason: 'badmail' })
          break
        }
        case 'mail-read':
          send({
            t: 'mail',
            messages: sessions.mailbox.read(
              typeof m.since === 'number' ? m.since : 0,
              typeof m.for === 'string' && m.for ? m.for : undefined
            )
          })
          break
        case 'set-role': {
          const ok = sessions.has(m.id) && sessions.mailbox.setRole(m.id, m.role)
          send({ t: 'role-set', id: m.id, ok })
          break
        }
        // ── Ownership ledger (Phase-4/02): claim / release / owners ──────────────
        // Both mutating verbs are pane-bound (boundToPane): territory is exactly the
        // thing one agent must not be able to shed or seize wearing another's id —
        // a forged `release --all` silently dissolved a sibling's claims.
        case 'claim': {
          if (typeof m.from !== 'string' || !m.from || !sessions.has(m.from)) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          if (!boundToPane('claim', m.from, m.token)) break
          const res = sessions.ledger.claim(m.from, m.pattern, sessions.mailbox.roleOf(m.from))
          if (res.ok) send({ t: 'claimed', id: res.id })
          else if (res.reason === 'denied') {
            send({ t: 'claim-denied', pattern: res.pattern, ownerPaneId: res.ownerPaneId })
          } else {
            send({ t: 'error', reason: 'badpattern' })
          }
          break
        }
        case 'release': {
          if (typeof m.from !== 'string' || !m.from || !sessions.has(m.from)) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          if (!boundToPane('release', m.from, m.token)) break
          send({ t: 'released', count: sessions.ledger.release(m.from, m.pattern, m.all === true) })
          break
        }
        case 'owners':
          send({ t: 'owners', claims: sessions.ledger.owners() })
          break
        // ── Reviewer gate (Phase-4/03). Memory-only coordination data.
        //
        // `token` (the pane's env-only MOGGING_PANE_TOKEN) proves the sender really is the
        // pane named in `from`. It has to: pane ids are public — `mogging list` prints them —
        // and EVERY pane can read the 0600 endpoint file and authenticate, so `from` on its
        // own was a claim, not a fact, and a worker could sign off on its own branch by
        // naming the reviewer's id. Every sender must present that pane's exact token.
        //
        // The role check below is a COURTESY, not the gate: `set-role` is open to any
        // authenticated client (i.e. any pane), so a pane can promote itself and this check
        // will wave it through. It stays because it gives `mogging approve` from an ordinary
        // pane a fast, honest refusal (exit 6) instead of a sign-off that dies silently later.
        //
        // THE gate is in the app, where a pane cannot reach: main only believes a sign-off
        // from a pane the USER made a reviewer, recorded on the renderer-only setRole IPC
        // (src/main/daemon-relay.ts, `appRoles` — read that comment for the whole argument).
        // Nothing the daemon can be told about roles opens a merge. ──
        case 'approve': {
          if (typeof m.from !== 'string' || !m.from || !sessions.has(m.from)) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          const claimed = sessions.get(m.from)
          if (typeof m.token !== 'string' || !m.token || m.token !== claimed?.paneToken) {
            log(`approve REFUSED: token does not bind the sender to pane ${m.from}`)
            send({ t: 'error', reason: 'notreviewer' })
            break
          }
          const role = sessions.mailbox.roleOf(m.from)
          if (role !== 'reviewer') {
            send({ t: 'error', reason: 'notreviewer' })
            break
          }
          if (!validReviewSnapshot(m.snapshot)) {
            send({ t: 'error', reason: 'badbranch' })
            break
          }
          const approval = {
            snapshot: m.snapshot,
            branch: m.snapshot.branch,
            repoId: m.snapshot.repoId,
            byPaneId: m.from,
            byRole: role,
            ts: Date.now()
          }
          sessions.approvals.set(approvalKey(approval.repoId, approval.branch), approval)
          send({ t: 'approved', branch: approval.branch, byPaneId: m.from, byRole: role })
          pushApprovals()
          break
        }
        case 'approvals':
          send({ t: 'approvals', list: [...sessions.approvals.values()] })
          break
        case 'unapprove':
          // The branch's worktree is gone (app-side removal) — sign-off dies with it.
          if (
            typeof m.repoId === 'string' &&
            typeof m.branch === 'string' &&
            sessions.approvals.delete(approvalKey(m.repoId, m.branch))
          ) pushApprovals()
          break
        case 'ping':
          if (Date.now() < pingMuteUntil) break // gate seam only — see pingMuteUntil
          send({ t: 'pong' })
          break
        case 'shutdown':
          log('shutdown requested by ' + who)
          hooks.onShutdown(0)
          break
      }
    }

    const framer = createLineFramer((obj) => {
      const m = obj as ClientMessage
      if (!authed) {
        if (m.t === 'hello' && m.v === DAEMON_PROTOCOL_VERSION && m.token === token) {
          authed = true
          who = describeClient(m.client)
          clearTimeout(authTimer)
          // Counted BEFORE this connection joins the set: `otherClients` is "how many authed
          // connections exist besides YOU" — what a stamp-retire probe needs to know whether a
          // different build's live session would be killed by a retire (see the welcome type).
          const otherClients = authedClients.size
          authedClients.add(send)
          hooks.onClientCountChange(1)
          hooks.onActivity()
          send({
            t: 'welcome',
            v: DAEMON_PROTOCOL_VERSION,
            panes: sessions.list(),
            workspaces: sessions.workspaces(),
            otherClients
          })
        } else {
          send({ t: 'error', reason: 'auth' })
          sock.destroy()
        }
        return
      }
      hooks.onActivity()
      handle(m)
    })

    sock.on('data', (chunk: string) => framer(chunk))
    sock.on('error', () => {
      /* ignore; close handler cleans up */
    })
    sock.on('close', () => {
      clearTimeout(authTimer)
      authedClients.delete(send)
      // Unbind from the session each sub is ACTUALLY on (stored ref) — `sessions.get(id)`
      // may already name a newer generation this connection never subscribed to.
      for (const { sub, session } of subscriptions.values()) session.unsubscribe(sub)
      subscriptions.clear()
      if (authed) hooks.onClientCountChange(-1)
    })
  })

  server.on('error', (e) => {
    log('server error ' + e)
    hooks.onShutdown(1)
  })
  return server
}
