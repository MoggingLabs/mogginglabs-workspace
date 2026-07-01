// Socket/named-pipe server: framing, the version + auth-token handshake (unauthenticated
// connections are dropped within seconds), and per-connection pane subscriptions. (ADR 0006.)
import * as net from 'node:net'
import { createLineFramer, encodeMessage, DAEMON_PROTOCOL_VERSION } from '@contracts'
import type { ClientMessage, ServerMessage } from '@contracts'
import type { SessionManager, PaneSubscriber } from './session'
import { log } from './lifecycle'

export interface TransportHooks {
  onActivity(): void
  onClientCountChange(delta: number): void
}

export function createServer(sessions: SessionManager, token: string, hooks: TransportHooks): net.Server {
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
        case 'list':
          send({ t: 'panes', panes: sessions.list() })
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
