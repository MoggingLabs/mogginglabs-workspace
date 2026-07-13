// SQLite-backed persistence for terminal sessions + workspaces (Phase-1/03). Electron-free
// (better-sqlite3 is a Node native module, rebuilt for Electron's ABI by the postinstall
// `electron-builder install-app-deps`), so it runs inside the daemon (ADR 0006) — which owns
// the sessions — and could equally back the in-proc path.
//
// SECURITY (ADR 0002): stores ONLY id / cwd / command-label / scrollback — the user's own
// local terminal state. It NEVER stores provider credentials; the app doesn't handle those
// (agent CLIs self-authenticate). `command` is a launch label like "claude", not a token.
import Database from 'better-sqlite3'
import { normalizeRemoteConnection, type PersistedPane, type PersistedWorkspace } from '@contracts'

const MAX_SCROLLBACK = 100_000

export class SessionStore {
  private readonly db: Database.Database

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
    try {
      this.db.exec("ALTER TABLE panes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'")
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec('ALTER TABLE panes ADD COLUMN reported_cwd TEXT')
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec('ALTER TABLE panes ADD COLUMN reported_cwd_at INTEGER')
    } catch {
      /* column already exists */
    }
    for (const [column, type] of [
      ['remote_name', 'TEXT'],
      ['remote_host', 'TEXT'],
      ['remote_user', 'TEXT'],
      ['remote_port', 'INTEGER'],
      ['remote_cwd', 'TEXT'],
      ['remote_platform', 'TEXT']
    ] as const) {
      try {
        this.db.exec(`ALTER TABLE panes ADD COLUMN ${column} ${type}`)
      } catch {
        /* column already exists */
      }
    }
  }

  loadPanes(): PersistedPane[] {
    const rows = this.db
      .prepare(
        'SELECT id, workspace_id AS workspaceId, cwd, reported_cwd AS reportedCwd, reported_cwd_at AS reportedCwdAt, remote_name AS remoteName, remote_host AS remoteHost, remote_user AS remoteUser, remote_port AS remotePort, remote_cwd AS remoteCwd, remote_platform AS remotePlatform, command, scrollback, updated_at AS updatedAt FROM panes'
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
        remote: remote ? { ...remote, cwd: r.remoteCwd ?? undefined } : undefined,
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
        'INSERT INTO panes (id, workspace_id, cwd, reported_cwd, reported_cwd_at, remote_name, remote_host, remote_user, remote_port, remote_cwd, remote_platform, command, scrollback, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
