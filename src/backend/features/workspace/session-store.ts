// SQLite-backed persistence for terminal sessions + workspaces (Phase-1/03). Electron-free
// (better-sqlite3 is a Node native module and ABI-bound, so it arrives through the
// host-aware seam below: the helper's own build inside the daemon, Electron's build under
// the in-proc path — ADR 0016), so it runs inside the daemon (ADR 0006) — which owns
// the sessions — and could equally back the in-proc path.
//
// SECURITY (ADR 0002): stores ONLY id / cwd / command-label / scrollback — the user's own
// local terminal state. It NEVER stores provider credentials; the app doesn't handle those
// (agent CLIs self-authenticate). `command` is a launch label like "claude", not a token.
import type BetterSqlite3 from 'better-sqlite3'
import { requireNative } from '@backend/platform/native-require'
import { normalizeRemoteConnection, type PersistedPane, type PersistedWorkspace } from '@contracts'
import { addColumnIfMissing } from './db-migrate'

const Database = requireNative<typeof import('better-sqlite3')>('better-sqlite3')

/** The persisted shell dialects a remote row may carry (PersistedPane.remote.shell). */
const REMOTE_SHELLS = new Set(['sh', 'bash', 'zsh', 'powershell', 'cmd'])
type PersistedRemoteShell = NonNullable<NonNullable<PersistedPane['remote']>['shell']>
const asRemoteShell = (value: string | null): PersistedRemoteShell | undefined =>
  value !== null && REMOTE_SHELLS.has(value) ? (value as PersistedRemoteShell) : undefined

const MAX_SCROLLBACK = 100_000

export class SessionStore {
  private readonly db: BetterSqlite3.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL') // durable across a crash; recovers on next open
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS panes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        cwd TEXT NOT NULL,
        reported_cwd TEXT,
        reported_cwd_at INTEGER,
        remote_name TEXT,
        remote_host TEXT,
        remote_user TEXT,
        remote_port INTEGER,
        remote_cwd TEXT,
        remote_platform TEXT,
        remote_shell TEXT,
        command TEXT,
        scrollback TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT,
        layout TEXT,
        updated_at INTEGER NOT NULL
      );
    `)
    // Migrate pre-workspace dbs: panes gained a workspace binding. CREATE TABLE IF NOT EXISTS
    // NO-OPS on a db whose panes table predates the column, so without this every loadPanes()
    // throws `no such column: workspace_id` — and the two callers fail in the two worst ways:
    // the daemon's cold-start restore() (src/pty-daemon/index.ts) does not catch it, so the
    // DAEMON never starts, and the cross-version hand-off (readPersistedPanes in
    // src/main/daemon-migrate.ts) swallows it to [], silently dropping every old session it
    // was there to rescue. Same guarded pattern as settings-store's migrations next door.
    for (const [column, type] of [
      ['workspace_id', "TEXT NOT NULL DEFAULT 'default'"],
      ['reported_cwd', 'TEXT'],
      ['reported_cwd_at', 'INTEGER'],
      ['remote_name', 'TEXT'],
      ['remote_host', 'TEXT'],
      ['remote_user', 'TEXT'],
      ['remote_port', 'INTEGER'],
      ['remote_cwd', 'TEXT'],
      ['remote_platform', 'TEXT'],
      // The persisted shell dialect (PersistedPane.remote.shell) — the contract has
      // always promised "a restored pane comes back speaking the same language", but
      // no column existed, so the field silently dropped on every persist.
      ['remote_shell', 'TEXT']
    ] as const) {
      addColumnIfMissing(this.db, 'panes', column, type)
    }
  }

  loadPanes(): PersistedPane[] {
    const rows = this.db
      .prepare(
        'SELECT id, workspace_id AS workspaceId, cwd, reported_cwd AS reportedCwd, reported_cwd_at AS reportedCwdAt, remote_name AS remoteName, remote_host AS remoteHost, remote_user AS remoteUser, remote_port AS remotePort, remote_cwd AS remoteCwd, remote_platform AS remotePlatform, remote_shell AS remoteShell, command, scrollback, updated_at AS updatedAt FROM panes'
      )
      .all() as Array<{
      id: string
      workspaceId: string
      cwd: string
      reportedCwd: string | null
      reportedCwdAt: number | null
      remoteName: string | null
      remoteHost: string | null
      remoteUser: string | null
      remotePort: number | null
      remoteCwd: string | null
      remotePlatform: string | null
      remoteShell: string | null
      command: string | null
      scrollback: string
      updatedAt: number
    }>
    return rows.flatMap((r) => {
      const hasRemoteFields =
        r.remoteName !== null ||
        r.remoteHost !== null ||
        r.remoteUser !== null ||
        r.remotePort !== null ||
        r.remoteCwd !== null ||
        r.remotePlatform !== null
      const remote = hasRemoteFields
        ? normalizeRemoteConnection({
            name: r.remoteName,
            host: r.remoteHost,
            user: r.remoteUser ?? undefined,
            port: r.remotePort ?? undefined,
            platform: r.remotePlatform
          })
        : null
      // A partial/corrupt/unsupported remote row must not fail open as a local shell.
      if (hasRemoteFields && !remote) return []
      return [{
        id: r.id,
        workspaceId: r.workspaceId,
        cwd: r.cwd,
        reportedCwd: r.reportedCwd ?? undefined,
        reportedCwdAt: r.reportedCwdAt ?? undefined,
        // `shell` restores alongside the connection pointer: the contract's promise is
        // that a restored pane comes back speaking the dialect it went away in.
        remote: remote ? { ...remote, cwd: r.remoteCwd ?? undefined, shell: asRemoteShell(r.remoteShell) } : undefined,
        command: r.command ?? undefined,
        scrollback: r.scrollback,
        updatedAt: r.updatedAt
      }]
    })
  }

  /** Replace the persisted pane set atomically (a handful of panes — simple + safe). */
  savePanes(panes: PersistedPane[]): void {
    const tx = this.db.transaction((rows: PersistedPane[]) => {
      this.db.prepare('DELETE FROM panes').run()
      const ins = this.db.prepare(
        'INSERT INTO panes (id, workspace_id, cwd, reported_cwd, reported_cwd_at, remote_name, remote_host, remote_user, remote_port, remote_cwd, remote_platform, remote_shell, command, scrollback, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const p of rows)
        ins.run(
          p.id,
          p.workspaceId ?? 'default',
          p.cwd,
          p.reportedCwd ?? null,
          p.reportedCwdAt ?? null,
          p.remote?.name ?? null,
          p.remote?.host ?? null,
          p.remote?.user ?? null,
          p.remote?.port ?? null,
          p.remote?.cwd ?? null,
          p.remote?.platform ?? null,
          p.remote?.shell ?? null,
          p.command ?? null,
          p.scrollback.slice(-MAX_SCROLLBACK),
          p.updatedAt
        )
    })
    tx(panes)
  }

  loadWorkspaces(): PersistedWorkspace[] {
    const rows = this.db
      .prepare('SELECT id, name, layout, updated_at AS updatedAt FROM workspaces')
      .all() as Array<{ id: string; name: string | null; layout: string | null; updatedAt: number }>
    return rows.map((r) => ({ id: r.id, name: r.name ?? undefined, layout: r.layout ?? undefined, updatedAt: r.updatedAt }))
  }

  saveWorkspaces(workspaces: PersistedWorkspace[]): void {
    const tx = this.db.transaction((rows: PersistedWorkspace[]) => {
      this.db.prepare('DELETE FROM workspaces').run()
      const ins = this.db.prepare('INSERT INTO workspaces (id, name, layout, updated_at) VALUES (?, ?, ?, ?)')
      for (const w of rows) ins.run(w.id, w.name ?? null, w.layout ?? null, w.updatedAt)
    })
    tx(workspaces)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}
