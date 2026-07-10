// Env-gated daemon-migration smoke (MOGGING_MIGRATE=1) — windowless, no daemon boot.
// Gates the DEAD-daemon path of daemon-migrate.ts: an older-version runtime dir holding
// only a persisted sessions.db (its daemon long gone) must seed OUR store verbatim on
// the first launch of a new protocol version, and never run twice (idempotence guard).
//
// It runs BEFORE startDaemonBackend (index.ts) — the one moment the real migration also
// gets: our runtime dir has no sessions.db yet, which is the entry condition under test.
// The LIVE-capture path (a running old daemon retired over its own wire) is deliberately
// out of scope here — it needs a second, older daemon binary; the dead path covers the
// store discovery, channel scoping, seeding fidelity, and the hands-off guard that both
// paths share.
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DAEMON_PROTOCOL_VERSION, channelFromEnv } from '@contracts'
import type { PersistedPane } from '@contracts'
import { SessionStore } from '@backend/features/workspace'
import { runtimeDir } from './daemon-client'
import { migrateOlderDaemonSessions } from './daemon-migrate'

export async function runMigrateSmoke(): Promise<void> {
  const write = (o: object): void => {
    try {
      const out = path.join(app.getAppPath(), 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'migrate-result.json'), JSON.stringify(o, null, 2))
    } catch {
      /* best effort */
    }
  }
  setTimeout(() => {
    write({ pass: false, error: 'TIMEOUT: migrate smoke did not complete' })
    app.exit(1)
  }, 30000)

  try {
    const target = runtimeDir()
    const targetDb = path.join(target, 'sessions.db')
    const root = path.dirname(target)
    const prefix = channelFromEnv() === 'dev' ? 'dev-v' : 'v'
    const oldDir = path.join(root, `${prefix}${DAEMON_PROTOCOL_VERSION - 1}`)

    // RE-ENTRY guard (electron-vite dev respawns electron after app.exit): a previous
    // pass already seeded our store with the marker rows — leave its verdict alone.
    if (fs.existsSync(targetDb)) {
      const probe = new SessionStore(targetDb)
      const already = probe.loadPanes().some((r) => r.id === 'mig-1')
      probe.close()
      if (already) {
        app.exit(0)
        return
      }
    }

    // Entry condition: a first boot of THIS protocol version (fresh isolated userdata).
    const freshStart = !fs.existsSync(targetDb)

    // Seed the old dir: a persisted store, NO endpoint.json — a dead daemon's estate.
    fs.mkdirSync(oldDir, { recursive: true })
    const seeded: PersistedPane[] = [
      {
        id: 'mig-1',
        workspaceId: 'ws-old',
        cwd: root,
        command: 'claude',
        scrollback: 'MIGRATED_SCROLLBACK_1\nline two',
        updatedAt: Date.now()
      },
      { id: 'mig-2', workspaceId: 'ws-old', cwd: oldDir, scrollback: '', updatedAt: Date.now() }
    ]
    const oldStore = new SessionStore(path.join(oldDir, 'sessions.db'))
    oldStore.savePanes(seeded)
    oldStore.close()

    const migrated = await migrateOlderDaemonSessions()

    // Fidelity: both rows landed in our store with cwd/command/scrollback intact.
    let rows: PersistedPane[] = []
    if (fs.existsSync(targetDb)) {
      const store = new SessionStore(targetDb)
      rows = store.loadPanes()
      store.close()
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    const r1 = byId.get('mig-1')
    const r2 = byId.get('mig-2')
    const fidelity =
      rows.length === 2 &&
      !!r1 && r1.cwd === root && r1.command === 'claude' && r1.scrollback === 'MIGRATED_SCROLLBACK_1\nline two' &&
      !!r2 && r2.cwd === oldDir && r2.command === undefined && r2.scrollback === ''

    // Idempotence: our store now exists, so a second call must refuse to touch anything.
    const second = await migrateOlderDaemonSessions()

    // The old dir is left in place as a natural backup — never destroyed.
    const oldIntact = fs.existsSync(path.join(oldDir, 'sessions.db'))

    const pass = freshStart && migrated === 2 && fidelity && second === 0 && oldIntact
    write({ pass, freshStart, migrated, fidelity, second, oldIntact, rows })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    app.exit(1)
  }
}
