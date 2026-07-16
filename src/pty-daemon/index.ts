// Detached PTY daemon entry point (ADR 0006). Launched by the app via Electron-as-Node
// (`ELECTRON_RUN_AS_NODE=1`, `process.execPath`) so it needs no system Node and shares the
// app's node-pty (compiled from source). It outlives the app (spawned detached) and holds the
// PTYs; the app is a thin client that reconnects on each launch.
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION } from '@contracts'
import { buildStampOf } from '@backend/platform/build-stamp'
import { SessionStore } from '@backend/features/workspace'
import { SessionManager } from './session'
import { createServer } from './transport'
import {
  acquireLock,
  releaseLock,
  writeEndpoint,
  clearEndpoint,
  socketAddress,
  runtimeDir,
  endpointPath,
  otherVersionEndpoints,
  log
} from './lifecycle'

// Shut down when there are no clients AND no panes for this long (no zombie daemons).
const IDLE_SHUTDOWN_MS = Number(process.env.MOGGING_DAEMON_IDLE_MS ?? 30 * 60 * 1000)

/**
 * Open the session store, surviving a corrupt file. A sqlite open/migration throw used
 * to abort main() — the daemon never came up, the app fell back to in-proc, and every
 * later boot repeated it (the file does not heal). Losing restorable sessions is bad;
 * losing the DAEMON — forever — over one bad file is strictly worse. The corrupt file
 * is set aside (evidence, and a manual recovery path), and a fresh store carries on.
 */
function openSessionStore(dbPath: string): SessionStore {
  try {
    return new SessionStore(dbPath)
  } catch (e) {
    log('SESSION STORE OPEN FAILED ' + (e instanceof Error && e.stack ? e.stack : String(e)))
    const aside = `${dbPath}.corrupt-${Date.now().toString(36)}`
    try {
      fs.renameSync(dbPath, aside)
      log('set the corrupt store aside at ' + aside)
    } catch {
      /* locked or already gone — the fresh open below decides */
    }
    return new SessionStore(dbPath)
  }
}

function main(): void {
  if (!acquireLock()) {
    log('another live daemon holds the lock; exiting')
    process.exit(0)
  }

  // BEFORE the store opens and restore() spawns anything: the daemon outlives a main crash
  // by design (ADR 0006), so it logs and keeps serving rather than exiting. Installed this
  // early, a throw during store open / cold-start restore is a logged breadcrumb too —
  // installed after them (as it used to be), that same throw crashed the daemon with
  // nothing in daemon.log, and the app silently fell back to in-proc every boot.
  // Both channels must reach daemon.log — an unlogged rejection is a pane that stops
  // responding with nothing to point at.
  process.on('uncaughtException', (e) => log('UNCAUGHT ' + (e && e.stack ? e.stack : e)))
  process.on('unhandledRejection', (e) => log('UNHANDLED ' + (e instanceof Error && e.stack ? e.stack : String(e))))

  // Inject the endpoint FILE path (not the token) into every pane so `mogging notify` inside a
  // pane can find + auth to this daemon (Phase-2/04). The token stays in the 0600 endpoint file.
  const sessions = new SessionManager(openSessionStore(path.join(runtimeDir(), 'sessions.db')), {
    MOGGING_DAEMON_ENDPOINT: endpointPath()
  })
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
    },
    onShutdown: (code) => shutdown(code)
  })

  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))

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
    // The build stamp is taken from OUR OWN entry file, at startup — not passed in by the app
    // that spawned us. After an update replaces app.asar the path holds NEW bytes, but this
    // process keeps running the old code; hashing once at boot records what we actually ARE,
    // which is precisely what lets the updated app see that we are stale (build-stamp.ts).
    writeEndpoint({
      version: DAEMON_PROTOCOL_VERSION,
      address,
      token,
      pid: process.pid,
      build: buildStampOf(process.argv[1] ?? '') ?? undefined
    })
    log('listening ' + address + ' pid ' + process.pid)
    const others = otherVersionEndpoints()
    // Informational only: the APP owns the cross-version hand-off (src/main/daemon-migrate.ts
    // captures + retires an older daemon before this one is ever spawned), so a live entry
    // here usually means a deferred migration or a side-by-side older release.
    if (others.length) log('other-version daemons live: ' + JSON.stringify(others))
    armIdle()
  })
}

main()
