// App-level workspace state (tabs + theme + 06b template lineups) for Phase-1/05-06b,
// persisted with the same better-sqlite3 mechanism as the session store (03). Electron-free.
// Metadata ONLY — no credentials (ADR 0002). Kept in a SEPARATE db from the daemon's
// sessions.db so the two processes never contend on one file: main owns this; daemon owns sessions.
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  AgentProfile,
  RemoteHost,
  BoardCard,
  ProviderCount,
  ProviderMixTemplate,
  RecentWorkspace,
  WorkspaceState,
  WorkspaceStateMeta
} from '@contracts'

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
        position INTEGER NOT NULL,
        assignments TEXT
      );
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, mix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_remotes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        user TEXT,
        port INTEGER,
        identity_hint TEXT
      );
      CREATE TABLE IF NOT EXISTS app_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        env TEXT NOT NULL DEFAULT '{}',
        ord INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS app_board (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        lane TEXT NOT NULL DEFAULT 'todo',
        pane_id INTEGER,
        workspace_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
    `)
    // Migrate pre-06b dbs that lack the assignments column (per-workspace template lineup).
    try {
      this.db.exec('ALTER TABLE app_workspaces ADD COLUMN assignments TEXT')
    } catch {
      /* column already exists */
    }
    // Migrate pre-3/03 dbs: per-slot cwd overrides (worktree isolation).
    try {
      this.db.exec('ALTER TABLE app_workspaces ADD COLUMN pane_cwds TEXT')
    } catch {
      /* column already exists */
    }
    // Migrate pre-4/01 dbs: per-slot swarm roles.
    try {
      this.db.exec('ALTER TABLE app_workspaces ADD COLUMN pane_roles TEXT')
    } catch {
      /* column already exists */
    }
    // Migrate pre-4/05 dbs: per-slot remote hosts.
    try {
      this.db.exec('ALTER TABLE app_workspaces ADD COLUMN pane_remotes TEXT')
    } catch {
      /* column already exists */
    }
    // Migrate pre-6/04 dbs: per-slot launch profiles (ids only — ADR 0002).
    try {
      this.db.exec('ALTER TABLE app_workspaces ADD COLUMN pane_profile_ids TEXT')
    } catch {
      /* column already exists */
    }
    // Migrate to simplified profiles: the subscription email (a label — ADR 0002).
    try {
      this.db.exec('ALTER TABLE app_profiles ADD COLUMN email TEXT')
    } catch {
      /* column already exists */
    }
    // Migrate pre-split-tree dbs: the serialized pane arrangement (shape + sizes).
    try {
      this.db.exec('ALTER TABLE app_workspaces ADD COLUMN layout_tree TEXT')
    } catch {
      /* column already exists */
    }
  }

  /** Guarded per-field JSON parse: one corrupt cell drops that FIELD, never the row —
   *  and never throws out of load(). A throwing load() looks like a brand-new install
   *  to the renderer, whose next save (DELETE FROM app_workspaces) would wipe every
   *  intact row. Corruption must degrade, not cascade. */
  private static parseCell<T>(raw: string | null): T | undefined {
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  load(): WorkspaceState {
    const rows = this.db
      .prepare(
        'SELECT id, name, color, cwd, ordinal, pane_count AS paneCount, layout_tree AS layoutTree, assignments, pane_cwds AS paneCwds, pane_roles AS paneRoles, pane_remotes AS paneRemotes, pane_profile_ids AS paneProfileIds FROM app_workspaces ORDER BY position'
      )
      .all() as Array<WorkspaceStateMeta & { layoutTree: string | null; assignments: string | null; paneCwds: string | null; paneRoles: string | null; paneRemotes: string | null; paneProfileIds: string | null }>
    const workspaces: WorkspaceStateMeta[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      cwd: r.cwd,
      ordinal: r.ordinal,
      paneCount: r.paneCount,
      layout: r.layoutTree ?? undefined,
      assignments: SettingsStore.parseCell<string[]>(r.assignments),
      paneCwds: SettingsStore.parseCell<(string | null)[]>(r.paneCwds),
      roles: SettingsStore.parseCell<(string | null)[]>(r.paneRoles),
      remotes: SettingsStore.parseCell<({ hostId: string; name: string } | null)[]>(r.paneRemotes),
      profileIds: SettingsStore.parseCell<(string | null)[]>(r.paneProfileIds)
    }))
    const settings = this.db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string
      value: string
    }>
    const map = new Map(settings.map((s) => [s.key, s.value]))
    let recents: RecentWorkspace[] | undefined
    try {
      const raw = map.get('recents')
      recents = raw ? (JSON.parse(raw) as RecentWorkspace[]) : undefined
    } catch {
      recents = undefined
    }
    return {
      workspaces,
      activeId: map.get('activeId') || null,
      theme: map.get('theme') || 'midnight',
      recents
    }
  }

  /** Replace all app-level workspace state atomically. */
  save(state: WorkspaceState): void {
    const tx = this.db.transaction((s: WorkspaceState) => {
      this.db.prepare('DELETE FROM app_workspaces').run()
      const ins = this.db.prepare(
        'INSERT INTO app_workspaces (id, name, color, cwd, ordinal, pane_count, layout_tree, position, assignments, pane_cwds, pane_roles, pane_remotes, pane_profile_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      s.workspaces.forEach((w, i) =>
        ins.run(
          w.id,
          w.name,
          w.color,
          w.cwd,
          w.ordinal,
          w.paneCount,
          w.layout ?? null,
          i,
          w.assignments ? JSON.stringify(w.assignments) : null,
          w.paneCwds ? JSON.stringify(w.paneCwds) : null,
          w.roles ? JSON.stringify(w.roles) : null,
          w.remotes ? JSON.stringify(w.remotes) : null,
          w.profileIds ? JSON.stringify(w.profileIds) : null
        )
      )
      const set = this.db.prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      set.run('activeId', s.activeId ?? '')
      set.run('theme', s.theme)
      set.run('recents', JSON.stringify(s.recents ?? []))
    })
    tx(state)
  }

  // ── Generic app KV (Phase-6/05): small feature settings that need no schema
  // (browser dock open/width, per-workspace last preview URL). Same table as
  // theme/activeId; values are metadata only — never credentials (ADR 0002). ──
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  // --- Telemetry consent + anonymous install id (observability/00, ADR 0005) -----
  // Stored in the same KV table. The install id is a random UUID minted on first read —
  // never derived from the machine, account, or provider identity. Consent defaults OFF.

  // ── Kanban board (Phase-3/05). Card text is USER CONTENT: this local table is
  // its ONLY home — board rows never feed telemetry, notify, or logs (ADR 0005). ──
  listBoard(): BoardCard[] {
    const rows = this.db
      .prepare(
        'SELECT id, title, notes, lane, pane_id AS paneId, workspace_id AS workspaceId, created_at AS createdAt, updated_at AS updatedAt FROM app_board ORDER BY position, created_at'
      )
      .all() as BoardCard[]
    return rows
  }

  saveBoardCard(card: BoardCard): void {
    this.db
      .prepare(
        `INSERT INTO app_board (id, title, notes, lane, pane_id, workspace_id, created_at, updated_at)
         VALUES (@id, @title, @notes, @lane, @paneId, @workspaceId, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, notes = excluded.notes, lane = excluded.lane,
           pane_id = excluded.pane_id, workspace_id = excluded.workspace_id,
           updated_at = excluded.updated_at`
      )
      .run({
        id: card.id,
        title: card.title,
        notes: card.notes,
        lane: card.lane,
        paneId: card.paneId ?? null,
        workspaceId: card.workspaceId ?? null,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt
      })
  }

  removeBoardCard(id: string): void {
    this.db.prepare('DELETE FROM app_board WHERE id = ?').run(id)
  }

  // ── Remote hosts (Phase-4/05): connection POINTERS; auth is the user's ssh stack. ──
  listRemotes(): RemoteHost[] {
    const rows = this.db
      .prepare('SELECT id, name, host, user, port, identity_hint AS identityHint FROM app_remotes ORDER BY name')
      .all() as Array<RemoteHost & { user: string | null; port: number | null; identityHint: string | null }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      user: r.user ?? undefined,
      port: r.port ?? undefined,
      identityHint: r.identityHint ?? undefined
    }))
  }

  saveRemote(remote: RemoteHost): void {
    this.db
      .prepare(
        `INSERT INTO app_remotes (id, name, host, user, port, identity_hint)
         VALUES (@id, @name, @host, @user, @port, @identityHint)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host,
           user = excluded.user, port = excluded.port, identity_hint = excluded.identity_hint`
      )
      .run({
        id: remote.id,
        name: remote.name,
        host: remote.host,
        user: remote.user ?? null,
        port: remote.port ?? null,
        identityHint: remote.identityHint ?? null
      })
  }

  removeRemote(id: string): void {
    this.db.prepare('DELETE FROM app_remotes WHERE id = ?').run(id)
  }

  // ── Provider profiles (Phase-4/04): POINTER SETS, never secrets — the deny-list
  // lives at the IPC boundary (src/main/profiles.ts); this stores what survived it. ──
  listProfiles(): AgentProfile[] {
    const rows = this.db
      .prepare('SELECT id, name, provider, email, env, ord AS "order" FROM app_profiles ORDER BY provider, ord')
      .all() as Array<Omit<AgentProfile, 'env' | 'email'> & { env: string; email: string | null }>
    return rows.map((r) => ({
      ...r,
      email: r.email ?? undefined,
      env: SettingsStore.parseCell<Record<string, string>>(r.env) ?? {}
    }))
  }

  saveProfile(profile: AgentProfile): void {
    this.db
      .prepare(
        `INSERT INTO app_profiles (id, name, provider, email, env, ord) VALUES (@id, @name, @provider, @email, @env, @order)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider, email = excluded.email, env = excluded.env, ord = excluded.ord`
      )
      .run({ ...profile, email: profile.email ?? null, env: JSON.stringify(profile.env) })
  }

  removeProfile(id: string): void {
    this.db.prepare('DELETE FROM app_profiles WHERE id = ?').run(id)
  }

  getTelemetrySettings(): { installId: string; errorReporting: boolean; productAnalytics: boolean } {
    const rows = this.db
      .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'telemetry.%'")
      .all() as Array<{ key: string; value: string }>
    const map = new Map(rows.map((r) => [r.key, r.value]))
    let installId = map.get('telemetry.installId') ?? ''
    if (!installId) {
      installId = randomUUID()
      this.db
        .prepare(
          'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run('telemetry.installId', installId)
    }
    return {
      installId,
      errorReporting: map.get('telemetry.errorReporting') === '1',
      productAnalytics: map.get('telemetry.productAnalytics') === '1'
    }
  }

  setTelemetryConsent(consent: { errorReporting: boolean; productAnalytics: boolean }): void {
    const set = this.db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    set.run('telemetry.errorReporting', consent.errorReporting ? '1' : '')
    set.run('telemetry.productAnalytics', consent.productAnalytics ? '1' : '')
  }

  // --- 06b: saved provider-mix templates (metadata only — providers + counts) ---

  loadTemplates(): ProviderMixTemplate[] {
    const rows = this.db.prepare('SELECT id, name, mix FROM app_templates ORDER BY rowid').all() as Array<{
      id: string
      name: string
      mix: string
    }>
    return rows
      .map((r) => ({ id: r.id, name: r.name, mix: SettingsStore.parseCell<ProviderCount[]>(r.mix) }))
      .filter((t): t is ProviderMixTemplate => t.mix !== undefined)
  }

  saveTemplate(t: ProviderMixTemplate): void {
    this.db
      .prepare(
        'INSERT INTO app_templates (id, name, mix) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, mix = excluded.mix'
      )
      .run(t.id, t.name, JSON.stringify(t.mix))
  }

  removeTemplate(id: string): void {
    this.db.prepare('DELETE FROM app_templates WHERE id = ?').run(id)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}
