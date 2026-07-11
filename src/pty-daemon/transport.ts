// Socket/named-pipe server: framing, the version + auth-token handshake (unauthenticated
// connections are dropped within seconds), and per-connection pane subscriptions. (ADR 0006.)
import * as net from 'node:net'
import { createLineFramer, encodeMessage, keyToBytes, DAEMON_PROTOCOL_VERSION } from '@contracts'
import type { ClientMessage, ServerMessage } from '@contracts'
import { ptyEmulation } from '@backend/platform/pty-host'
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

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let authed = false
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
        cwd: (p) => send({ t: 'cwd', id, gen, cwd: p }),
        limit: () => send({ t: 'limit', id, gen })
      }
      subscriptions.set(id, { sub, session })
      session.subscribe(sub)
    }

    function handle(m: ClientMessage): void {
      switch (m.t) {
        case 'spawn': {
          const { pane, existed } = sessions.ensure(m.id, m.spec ?? {})
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
        case 'list':
          send({ t: 'panes', panes: sessions.list() })
          break
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
        case 'mail-send': {
          const from = typeof m.from === 'string' && m.from ? m.from : '0'
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
        case 'claim': {
          if (typeof m.from !== 'string' || !m.from || !sessions.has(m.from)) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
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
          if (typeof m.from !== 'string' || !m.from) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
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
        // naming the reviewer's id. A sender that presents a token must present the right one.
        //
        // HONEST LIMIT, and it is a real one: this makes `from` unforgeable, it does NOT make
        // the gate unforgeable. `set-role` above is itself unbound — any authenticated client
        // may name any pane's role — so a pane can promote ITSELF to reviewer and then approve
        // with its own perfectly valid token. Closing that needs a privileged app client (an
        // app-only secret the daemon withholds from pane env, gating set-role/kill), which
        // changes what `mogging role` may do from inside a pane — a product decision, not a
        // patch. Until then the gate REFEREES cooperating agents; it does not withstand a
        // hostile one. Do not describe it as a security boundary. ──
        case 'approve': {
          if (typeof m.from !== 'string' || !m.from || !sessions.has(m.from)) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          const claimed = sessions.get(m.from)
          if (typeof m.token === 'string' && m.token !== claimed?.paneToken) {
            log(`approve REFUSED: token does not bind the sender to pane ${m.from}`)
            send({ t: 'error', reason: 'notreviewer' })
            break
          }
          const role = sessions.mailbox.roleOf(m.from)
          if (role !== 'reviewer') {
            send({ t: 'error', reason: 'notreviewer' })
            break
          }
          if (typeof m.token !== 'string') {
            log(`approve accepted for pane ${m.from} WITHOUT a pane-token binding — sender identity unproven`)
          }
          if (typeof m.branch !== 'string' || !m.branch || m.branch.length > 256) {
            send({ t: 'error', reason: 'badbranch' })
            break
          }
          sessions.approvals.set(m.branch, { branch: m.branch, byPaneId: m.from, byRole: role, ts: Date.now() })
          send({ t: 'approved', branch: m.branch, byPaneId: m.from, byRole: role })
          pushApprovals()
          break
        }
        case 'approvals':
          send({ t: 'approvals', list: [...sessions.approvals.values()] })
          break
        case 'unapprove':
          // The branch's worktree is gone (app-side removal) — sign-off dies with it.
          if (typeof m.branch === 'string' && sessions.approvals.delete(m.branch)) pushApprovals()
          break
        case 'ping':
          send({ t: 'pong' })
          break
        case 'shutdown':
          log('shutdown requested by client')
          hooks.onShutdown(0)
          break
      }
    }

    const framer = createLineFramer((obj) => {
      const m = obj as ClientMessage
      if (!authed) {
        if (m.t === 'hello' && m.v === DAEMON_PROTOCOL_VERSION && m.token === token) {
          authed = true
          clearTimeout(authTimer)
          authedClients.add(send)
          hooks.onClientCountChange(1)
          hooks.onActivity()
          send({ t: 'welcome', v: DAEMON_PROTOCOL_VERSION, panes: sessions.list(), workspaces: sessions.workspaces() })
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
