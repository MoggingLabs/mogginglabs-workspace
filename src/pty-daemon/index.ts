// Detached PTY daemon entry point (ADR 0006). Launched by the app via Electron-as-Node
// (`ELECTRON_RUN_AS_NODE=1`, `process.execPath`) so it needs no system Node and shares the
// app's @lydell/node-pty prebuilt. It outlives the app (spawned detached) and holds the
// PTYs; the app is a thin client that reconnects on each launch.
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'
import { SessionManager } from './session'
import { createServer } from './transport'
import {
  acquireLock,
  releaseLock,
  writeEndpoint,
  clearEndpoint,
  socketAddress,
  otherVersionEndpoints,
  log
} from './lifecycle'

// Shut down when there are no clients AND no panes for this long (no zombie daemons).
const IDLE_SHUTDOWN_MS = Number(process.env.MOGGING_DAEMON_IDLE_MS ?? 30 * 60 * 1000)

function main(): void {
  if (!acquireLock()) {
    log('another live daemon holds the lock; exiting')
    process.exit(0)
  }

  const sessions = new SessionManager()
  const restored = sessions.restore() // cold-start recovery: re-create persisted panes
  if (restored) log('restored ' + restored + ' pane(s) from the session store')
  const token = crypto.randomBytes(24).toString('hex')
  const address = socketAddress(process.pid)

  let clients = 0
  let idleTimer: NodeJS.Timeout | undefined

  const shutdown = (code: number): void => {
    try {
      sessions.persistNow() // flush session state so the next start restores it
    } catch {
      /* best effort */
    }
    clearEndpoint()
    releaseLock()
    try {
      sessions.killAll()
    } catch {
      /* best effort */
    }
    try {
      server.close()
    } catch {
      /* best effort */
    }
    process.exit(code)
  }

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (clients === 0 && sessions.count() === 0) {
        log('idle shutdown')
        shutdown(0)
      } else {
        armIdle()
      }
    }, IDLE_SHUTDOWN_MS)
  }

  const server = createServer(sessions, token, {
    onActivity: () => armIdle(),
    onClientCountChange: (delta) => {
      clients += delta
    }
  })

  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  process.on('uncaughtException', (e) => log('UNCAUGHT ' + (e && e.stack ? e.stack : e)))

  server.listen(address, () => {
    // Defense in depth. Unix: restrict the socket to the owner (the dir is already 0700).
    // Windows: named pipes reject remote clients by default; local access is gated by the
    // random auth token, whose endpoint file lives in the per-user (ACL-protected)
    // LOCALAPPDATA runtime dir. Unauthenticated connections are dropped within ~3s.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(address, 0o600)
      } catch {
        /* best effort */
      }
    }
    writeEndpoint({ version: DAEMON_PROTOCOL_VERSION, address, token, pid: process.pid })
    log('listening ' + address + ' pid ' + process.pid)
    const others = otherVersionEndpoints()
    if (others.length) log('other-version daemons live (session migration pending Phase-1/03): ' + JSON.stringify(others))
    armIdle()
  })
}

main()
