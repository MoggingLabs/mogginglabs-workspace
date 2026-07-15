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
import { runtimeDir } from '../daemon-client'
import {
  addConfirmedRemoteIdentities,
  liveCaptureHasRestorableRemoteIdentity,
  mergeLiveCaptureRows,
  migrateOlderDaemonSessions,
  persistedRowsForDeadSource
} from '../daemon-migrate'

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

    // Fidelity: both rows land with cwd/scrollback intact. Pre-v7 did not persist remote
    // identity, so commands are deliberately not auto-resumed from a dead ambiguous source.
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
      !!r1 && r1.cwd === root && r1.command === undefined && r1.scrollback === 'MIGRATED_SCROLLBACK_1\nline two' &&
      !!r2 && r2.cwd === oldDir && r2.command === undefined && r2.scrollback === ''

    const v7DeadRows = persistedRowsForDeadSource(7, new Map(seeded.map((row) => [row.id, row])))
    const v7DeadCommandRetained = v7DeadRows.find((row) => row.id === 'mig-1')?.command === 'claude'

    // Idempotence: our store now exists, so a second call must refuse to touch anything.
    const second = await migrateOlderDaemonSessions()

    // The old dir is left in place as a natural backup — never destroyed.
    const oldIntact = fs.existsSync(path.join(oldDir, 'sessions.db'))

    // The live wire carries cwd/title/scrollback, but not remote or reported-cwd
    // metadata. Verify the live merge updates what it knows and preserves what it does not.
    const mergeAt = Date.now() + 10
    const merged = mergeLiveCaptureRows(
      { panes: [
        { info: { id: 'live-1', cwd: '/live/cwd', title: 'codex', remoteName: 'buildbox' }, scrollback: 'live tail' },
        { info: { id: 'live-bad', cwd: 'C:\\not-posix', title: 'claude', remoteName: 'buildbox' }, scrollback: null },
        { info: { id: 'reused-as-local', cwd: '/now/local', title: 'codex' }, scrollback: 'local tail' },
        { info: { id: 'reused-as-remote', cwd: '/now/remote', title: 'claude', remoteName: 'buildbox' }, scrollback: 'remote tail' },
        { info: { id: 'remote-name-mismatch', cwd: '/wrong/remote', title: 'claude', remoteName: 'newbox' }, scrollback: 'wrong tail' },
        { info: { id: 'stable-local', cwd: '/stable/local', title: 'codex' }, scrollback: 'stable tail' }
      ] },
      new Map<string, PersistedPane>([
        ['live-1', {
          id: 'live-1',
          workspaceId: 'ws-live',
          cwd: '/stored/cwd',
          reportedCwd: '/reported/cwd',
          reportedCwdAt: 123456,
          remote: { name: 'buildbox', host: 'build.example', user: 'dev', port: 2222, platform: 'posix' },
          command: 'claude',
          scrollback: 'stored tail',
          updatedAt: 1
        }],
        ['live-bad', {
          id: 'live-bad',
          workspaceId: 'ws-live',
          cwd: '',
          remote: { name: 'buildbox', host: 'build.example', cwd: '/stored/remote', platform: 'posix' },
          scrollback: 'stored tail',
          updatedAt: 1
        }],
        ['reused-as-local', {
          id: 'reused-as-local',
          workspaceId: 'stale-remote-workspace',
          cwd: '',
          reportedCwd: '/stale/remote/report',
          reportedCwdAt: 222,
          remote: { name: 'buildbox', host: 'build.example', platform: 'posix' },
          scrollback: 'stale remote tail',
          updatedAt: 1
        }],
        ['reused-as-remote', {
          id: 'reused-as-remote',
          workspaceId: 'stale-local-workspace',
          cwd: '/was/local',
          reportedCwd: '/stale/local/report',
          reportedCwdAt: 333,
          scrollback: 'stale local tail',
          updatedAt: 1
        }],
        ['remote-name-mismatch', {
          id: 'remote-name-mismatch',
          workspaceId: 'stale-remote-workspace',
          cwd: '',
          reportedCwd: '/stale/remote/report',
          reportedCwdAt: 444,
          remote: { name: 'buildbox', host: 'old.example', platform: 'posix' },
          scrollback: 'stale remote tail',
          updatedAt: 1
        }],
        ['stable-local', {
          id: 'stable-local',
          workspaceId: 'stable-workspace',
          cwd: '/old/local',
          reportedCwd: '/stable/report',
          reportedCwdAt: 555,
          scrollback: 'old local tail',
          updatedAt: 1
        }]
      ]),
      mergeAt
    )
    const mergedById = new Map(merged.map((row) => [row.id, row]))
    const mergedRemote = mergedById.get('live-1')
    const mergedInvalidRemote = mergedById.get('live-bad')
    const reusedAsLocal = mergedById.get('reused-as-local')
    const stableLocal = mergedById.get('stable-local')
    const liveMergeFidelity =
      mergedRemote?.cwd === '/stored/cwd' && mergedRemote.remote?.cwd === '/live/cwd' &&
      mergedRemote.command === 'codex' && mergedRemote.scrollback === 'live tail' &&
      mergedRemote.workspaceId === 'ws-live' && mergedRemote.reportedCwd === '/reported/cwd' &&
      mergedRemote.reportedCwdAt === 123456 && mergedRemote.remote?.host === 'build.example' &&
      mergedRemote.updatedAt === mergeAt && mergedInvalidRemote?.remote?.cwd === '/stored/remote' &&
      reusedAsLocal?.cwd === '/now/local' && reusedAsLocal.remote === undefined &&
      reusedAsLocal.reportedCwd === undefined && reusedAsLocal.reportedCwdAt === undefined &&
      reusedAsLocal.workspaceId === 'default' && !mergedById.has('reused-as-remote') &&
      !mergedById.has('remote-name-mismatch') && stableLocal?.reportedCwd === '/stable/report' &&
      stableLocal.reportedCwdAt === 555 && stableLocal.workspaceId === 'stable-workspace'

    // Protocol v6 stored no remote columns. Its live wire can identify a saved-host name,
    // but not the SSH host/user/port needed to recreate that pane. The retirement preflight
    // must therefore refuse shutdown while accepting the same capture with confirmed data.
    const legacyRemoteLive = {
      panes: [{
        info: { id: 'legacy-remote', cwd: '/srv/work', title: 'claude', remoteName: 'buildbox' },
        scrollback: 'legacy remote tail'
      }]
    }
    const legacyV6Persisted = new Map<string, PersistedPane>([[
      'legacy-remote',
      {
        id: 'legacy-remote',
        workspaceId: 'legacy-v6',
        cwd: root,
        command: 'claude',
        scrollback: 'persisted legacy tail',
        updatedAt: 1
      }
    ]])
    const legacyRemoteRetirementRefused =
      !liveCaptureHasRestorableRemoteIdentity(legacyRemoteLive, legacyV6Persisted)
    const recoveredLegacy = new Map(legacyV6Persisted)
    addConfirmedRemoteIdentities(
      legacyRemoteLive,
      recoveredLegacy,
      [{ name: 'buildbox', host: 'build.example', user: 'dev', port: 2222, platform: 'posix' }]
    )
    const confirmedSettingsRecoverLegacy =
      liveCaptureHasRestorableRemoteIdentity(legacyRemoteLive, recoveredLegacy) &&
      recoveredLegacy.get('legacy-remote')?.remote?.host === 'build.example'
    const confirmedRemoteRetirementAllowed = liveCaptureHasRestorableRemoteIdentity(
      legacyRemoteLive,
      new Map<string, PersistedPane>([[
        'legacy-remote',
        {
          ...legacyV6Persisted.get('legacy-remote')!,
          remote: { name: 'buildbox', host: 'build.example', platform: 'posix' }
        }
      ]])
    )

    const pass = freshStart && migrated === 2 && fidelity && v7DeadCommandRetained && second === 0 && oldIntact &&
      liveMergeFidelity && legacyRemoteRetirementRefused && confirmedRemoteRetirementAllowed
      && confirmedSettingsRecoverLegacy
    write({
      pass,
      freshStart,
      migrated,
      fidelity,
      v7DeadCommandRetained,
      second,
      oldIntact,
      liveMergeFidelity,
      legacyRemoteRetirementRefused,
      confirmedRemoteRetirementAllowed,
      confirmedSettingsRecoverLegacy,
      rows
    })
    app.exit(pass ? 0 : 1)
  } catch (e) {
    write({ pass: false, error: String(e) })
    app.exit(1)
  }
}
