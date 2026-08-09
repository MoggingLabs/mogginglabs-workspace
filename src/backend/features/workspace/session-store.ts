// SQLite-backed persistence for terminal sessions + workspaces (Phase-1/03). Electron-free
// (better-sqlite3 is a Node native module and ABI-bound, so it arrives through the
// host-aware seam below: the helper's own build inside the daemon, Electron's build under
// the in-proc path — ADR 0017), so it runs inside the daemon (ADR 0006) — which owns
// the sessions — and could equally back the in-proc path.
//
// SECURITY (ADR 0002): stores ONLY id / cwd / command-label / scrollback — the user's own
// local terminal state. It NEVER stores provider credentials; the app doesn't handle those
// (agent CLIs self-authenticate). `command` is a launch label like "claude", not a token.
//
// Row <-> pane mapping lives in session-rows.ts (pure, unit-tested) — one mapping for the
// full save AND the dirty-pane upsert, so the two write paths cannot drift.
import type BetterSqlite3 from 'better-sqlite3'
import { requireNative } from '@backend/platform/native-require'
import type { PersistedPane, PersistedWorkspace } from '@contracts'
import { addColumnIfMissing } from './db-migrate'
import { paneToRow, rowToPane, type PaneRowCells } from './session-rows'

const Database = requireNative<typeof import('better-sqlite3')>('better-sqlite3')

const PANE_COLUMNS =
  'id, workspace_id AS workspaceId, cwd, reported_cwd AS reportedCwd, reported_cwd_at AS reportedCwdAt, remote_name AS remoteName, remote_host AS remoteHost, remote_user AS remoteUser, remote_port AS remotePort, remote_cwd AS remoteCwd, remote_platform AS remotePlatform, remote_shell AS remoteShell, command, agent_id AS agentId, launch_intent AS launchIntent, scrollback, grid_cols AS gridCols, grid_rows AS gridRows, updated_at AS updatedAt'

const PANE_UPSERT =
  `INSERT INTO panes (id, workspace_id, cwd, reported_cwd, reported_cwd_at, remote_name, remote_host, remote_user, remote_port, remote_cwd, remote_platform, remote_shell, command, agent_id, launch_intent, scrollback, grid_cols, grid_rows, updated_at)
   VALUES (@id, @workspaceId, @cwd, @reportedCwd, @reportedCwdAt, @remoteName, @remoteHost, @remoteUser, @remotePort, @remoteCwd, @remotePlatform, @remoteShell, @command, @agentId, @launchIntent, @scrollback, @gridCols, @gridRows, @updatedAt)
   ON CONFLICT(id) DO UPDATE SET
     workspace_id = excluded.workspace_id, cwd = excluded.cwd,
     reported_cwd = excluded.reported_cwd, reported_cwd_at = excluded.reported_cwd_at,
     remote_name = excluded.remote_name, remote_host = excluded.remote_host,
     remote_user = excluded.remote_user, remote_port = excluded.remote_port,
     remote_cwd = excluded.remote_cwd, remote_platform = excluded.remote_platform,
     remote_shell = excluded.remote_shell, command = excluded.command,
     agent_id = excluded.agent_id, launch_intent = excluded.launch_intent,
     scrollback = excluded.scrollback, grid_cols = excluded.grid_cols,
     grid_rows = excluded.grid_rows, updated_at = excluded.updated_at`

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
        agent_id TEXT,
        launch_intent TEXT,
        scrollback TEXT NOT NULL,
        grid_cols INTEGER,
        grid_rows INTEGER,
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
      ['remote_shell', 'TEXT'],
      // The pane's grid (PersistedPane.cols/rows) — restore spawns at this size so a
      // typed resume boots its TUI at the pane's real width, not the 80×24 default
      // (the cold-start smear; see the contract's field doc).
      ['grid_cols', 'INTEGER'],
      ['grid_rows', 'INTEGER'],
      // What the pane was RUNNING, as the composer's input (PersistedPane.launch). Two
      // columns on purpose: `agent_id` is the tripwire that lets an unreadable intent
      // degrade VISIBLY instead of passing for a pane that was only ever a shell. Rows
      // written before these existed carry neither, and rowToPane derives the intent from
      // the legacy `command` string on read — so no backfill has to run here.
      ['agent_id', 'TEXT'],
      ['launch_intent', 'TEXT']
    ] as const) {
      addColumnIfMissing(this.db, 'panes', column, type)
    }
  }

  loadPanes(): PersistedPane[] {
    const rows = this.db.prepare(`SELECT ${PANE_COLUMNS} FROM panes`).all() as PaneRowCells[]
    return rows.map(rowToPane).filter((p): p is PersistedPane => p !== null)
  }

  /** Replace the persisted pane set atomically — the restore/migration/first-persist
   *  path, where the store's prior contents are not to be trusted. */
  savePanes(panes: PersistedPane[]): void {
    const tx = this.db.transaction((rows: PersistedPane[]) => {
      this.db.prepare('DELETE FROM panes').run()
      const ins = this.db.prepare(PANE_UPSERT)
      for (const p of rows) ins.run(paneToRow(p))
    })
    tx(panes)
  }

  /** The steady-state write: upsert only the panes that CHANGED and delete only the ones
   *  that CLOSED, in one transaction. The full rewrite above re-wrote every pane's whole
   *  scrollback (up to 100k chars each) on every coalesced persist — as often as every
   *  100 ms under cwd churn — for panes that had not changed at all. */
  applyPaneChanges(changed: PersistedPane[], removedIds: readonly string[]): void {
    const tx = this.db.transaction(() => {
      const del = this.db.prepare('DELETE FROM panes WHERE id = ?')
      for (const id of removedIds) del.run(id)
      const ins = this.db.prepare(PANE_UPSERT)
      for (const p of changed) ins.run(paneToRow(p))
    })
    tx()
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
