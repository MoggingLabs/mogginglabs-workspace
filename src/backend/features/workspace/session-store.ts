// SQLite-backed persistence for terminal sessions + workspaces (Phase-1/03). Electron-free
// (better-sqlite3 is a Node native module, rebuilt for Electron's ABI by the postinstall
// `electron-builder install-app-deps`), so it runs inside the daemon (ADR 0006) — which owns
// the sessions — and could equally back the in-proc path.
//
// SECURITY (ADR 0002): stores ONLY id / cwd / command-label / scrollback — the user's own
// local terminal state. It NEVER stores provider credentials; the app doesn't handle those
// (agent CLIs self-authenticate). `command` is a launch label like "claude", not a token.
import Database from 'better-sqlite3'
import type { PersistedPane, PersistedWorkspace } from '@contracts'

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
  }

  loadPanes(): PersistedPane[] {
    const rows = this.db
      .prepare('SELECT id, workspace_id AS workspaceId, cwd, command, scrollback, updated_at AS updatedAt FROM panes')
      .all() as Array<{
      id: string
      workspaceId: string
      cwd: string
      command: string | null
      scrollback: string
      updatedAt: number
    }>
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      cwd: r.cwd,
      command: r.command ?? undefined,
      scrollback: r.scrollback,
      updatedAt: r.updatedAt
    }))
  }

  /** Replace the persisted pane set atomically (a handful of panes — simple + safe). */
  savePanes(panes: PersistedPane[]): void {
    const tx = this.db.transaction((rows: PersistedPane[]) => {
      this.db.prepare('DELETE FROM panes').run()
      const ins = this.db.prepare(
        'INSERT INTO panes (id, workspace_id, cwd, command, scrollback, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const p of rows)
        ins.run(p.id, p.workspaceId ?? 'default', p.cwd, p.command ?? null, p.scrollback.slice(-MAX_SCROLLBACK), p.updatedAt)
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
