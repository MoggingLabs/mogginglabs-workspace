// App-level workspace state (tabs + theme) for Phase-1/05, persisted with the same
// better-sqlite3 mechanism as the session store (03). Electron-free. Metadata ONLY — no
// credentials (ADR 0002). Kept in a SEPARATE db from the daemon's sessions.db so the two
// processes never contend on one file: main owns this; the daemon owns sessions.
import Database from 'better-sqlite3'
import type { WorkspaceState, WorkspaceStateMeta } from '@contracts'

export class SettingsStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        cwd TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        pane_count INTEGER NOT NULL,
        position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  load(): WorkspaceState {
    const workspaces = this.db
      .prepare('SELECT id, name, color, cwd, ordinal, pane_count AS paneCount FROM app_workspaces ORDER BY position')
      .all() as WorkspaceStateMeta[]
    const settings = this.db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string
      value: string
    }>
    const map = new Map(settings.map((s) => [s.key, s.value]))
    return {
      workspaces,
      activeId: map.get('activeId') || null,
      theme: map.get('theme') || 'midnight'
    }
  }

  /** Replace all app-level workspace state atomically. */
  save(state: WorkspaceState): void {
    const tx = this.db.transaction((s: WorkspaceState) => {
      this.db.prepare('DELETE FROM app_workspaces').run()
      const ins = this.db.prepare(
        'INSERT INTO app_workspaces (id, name, color, cwd, ordinal, pane_count, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      s.workspaces.forEach((w, i) => ins.run(w.id, w.name, w.color, w.cwd, w.ordinal, w.paneCount, i))
      const set = this.db.prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      set.run('activeId', s.activeId ?? '')
      set.run('theme', s.theme)
    })
    tx(state)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}
