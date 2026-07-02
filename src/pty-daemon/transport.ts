// Socket/named-pipe server: framing, the version + auth-token handshake (unauthenticated
// connections are dropped within seconds), and per-connection pane subscriptions. (ADR 0006.)
import * as net from 'node:net'
import { createLineFramer, encodeMessage, keyToBytes, DAEMON_PROTOCOL_VERSION } from '@contracts'
import type { ClientMessage, ServerMessage } from '@contracts'
import type { SessionManager, PaneSubscriber } from './session'
import { log } from './lifecycle'

export interface TransportHooks {
  onActivity(): void
  onClientCountChange(delta: number): void
}

export function createServer(sessions: SessionManager, token: string, hooks: TransportHooks): net.Server {
  // Ownership-ledger pushes (4/02): every authed client gets a fresh `owners` on any
  // change (claim, release, pane exit) — the UI chips stay live with zero polling.
  const authedClients = new Set<(m: ServerMessage) => void>()
  sessions.ledger.onChange = () => {
    const msg: ServerMessage = { t: 'owners', claims: sessions.ledger.owners() }
    for (const push of authedClients) push(msg)
  }

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8')
    let authed = false
    const subscriptions = new Map<string, PaneSubscriber>()
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

    function subscribe(id: string): void {
      if (subscriptions.has(id)) return
      const sub: PaneSubscriber = {
        send: (d) => send({ t: 'data', id, data: d }),
        exit: (c) => send({ t: 'exit', id, code: c }),
        state: (st) => send({ t: 'state', id, state: st }),
        cwd: (p) => send({ t: 'cwd', id, cwd: p })
      }
      subscriptions.set(id, sub)
      sessions.get(id)?.subscribe(sub)
    }

    function handle(m: ClientMessage): void {
      switch (m.t) {
        case 'spawn': {
          const { pane, existed } = sessions.ensure(m.id, m.spec ?? {})
          subscribe(m.id)
          send({ t: 'spawned', id: m.id, existing: existed, scrollback: pane.scrollback })
          break
        }
        case 'attach': {
          const pane = sessions.get(m.id)
          if (!pane) {
            send({ t: 'error', reason: 'nopane' })
            break
          }
          subscribe(m.id)
          send({ t: 'attached', id: m.id, scrollback: pane.scrollback })
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
        case 'ping':
          send({ t: 'pong' })
          break
        case 'shutdown':
          log('shutdown requested by client')
          process.exit(0)
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
      for (const [id, sub] of subscriptions) sessions.get(id)?.unsubscribe(sub)
      subscriptions.clear()
      if (authed) hooks.onClientCountChange(-1)
    })
  })

  server.on('error', (e) => {
    log('server error ' + e)
    process.exit(1)
  })
  return server
}
