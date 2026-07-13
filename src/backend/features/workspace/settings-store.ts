// App-level workspace state and non-secret feature-owned desired state, persisted with the
// same better-sqlite3 mechanism as the session store (03). Electron-free. NO credentials
// (ADR 0002). Kept in a SEPARATE db from the daemon's
// sessions.db so the two processes never contend on one file: main owns this; daemon owns sessions.
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  AgentConfigOverrideRecord,
  AgentConfigProviderId,
  AgentConfigScope,
  AgentConfigSurface,
  AgentConfigSyncState,
  AgentConfigValue,
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
        platform TEXT CHECK (platform = 'posix'),
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
      CREATE TABLE IF NOT EXISTS app_agent_config_overrides (
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        target_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        setting_id TEXT NOT NULL,
        path TEXT NOT NULL,
        operation TEXT NOT NULL,
        desired_value TEXT,
        ownership TEXT NOT NULL,
        baseline_present INTEGER NOT NULL DEFAULT 0,
        baseline_value TEXT,
        catalog_version TEXT NOT NULL,
        last_applied_value TEXT,
        last_applied_hash TEXT,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        applied_at INTEGER,
        PRIMARY KEY (provider, scope, target_id, surface, setting_id)
      );
      CREATE INDEX IF NOT EXISTS app_agent_config_target_idx
        ON app_agent_config_overrides (provider, scope, target_id);
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
    // Remote terminal bootstrapping is intentionally POSIX-only. Existing rows remain
    // NULL/unconfirmed until the user explicitly confirms the platform in Settings.
    try {
      this.db.exec("ALTER TABLE app_remotes ADD COLUMN platform TEXT CHECK (platform = 'posix')")
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
    // Development builds predating ADR 0011's explicit set/unset distinction.
    try {
      this.db.exec("ALTER TABLE app_agent_config_overrides ADD COLUMN operation TEXT NOT NULL DEFAULT 'set'")
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
      remotes: SettingsStore.parseCell<({ hostId: string; name: string; cwd?: string } | null)[]>(r.paneRemotes),
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

  // ── Agent CLI desired settings (ADR 0011) ──────────────────────────────────
  // A row owns ONE provider key at ONE honest layer. JSON values keep the table
  // format-neutral; provider codecs translate only at the filesystem boundary.

  listAgentConfigOverrides(filter?: {
    provider?: AgentConfigProviderId
    scope?: AgentConfigScope
    targetId?: string
  }): AgentConfigOverrideRecord[] {
    const clauses: string[] = []
    const args: unknown[] = []
    if (filter?.provider) {
      clauses.push('provider = ?')
      args.push(filter.provider)
    }
    if (filter?.scope) {
      clauses.push('scope = ?')
      args.push(filter.scope)
    }
    if (filter?.targetId) {
      clauses.push('target_id = ?')
      args.push(filter.targetId)
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT provider, scope, target_id AS targetId, surface, setting_id AS settingId,
                path, operation, desired_value AS desiredValue, ownership,
                baseline_present AS baselinePresent, baseline_value AS baselineValue,
                catalog_version AS catalogVersion, last_applied_value AS lastAppliedValue,
                last_applied_hash AS lastAppliedHash, status, last_error AS lastError,
                created_at AS createdAt, updated_at AS updatedAt, applied_at AS appliedAt
           FROM app_agent_config_overrides${where}
          ORDER BY provider, scope, target_id, surface, setting_id`
      )
      .all(...args) as Array<{
      provider: AgentConfigProviderId
      scope: AgentConfigScope
      targetId: string
      surface: AgentConfigSurface
      settingId: string
      path: string
      operation: 'set' | 'unset'
      desiredValue: string | null
      ownership: 'once' | 'enforce'
      baselinePresent: number
      baselineValue: string | null
      catalogVersion: string
      lastAppliedValue: string | null
      lastAppliedHash: string | null
      status: AgentConfigSyncState
      lastError: string | null
      createdAt: number
      updatedAt: number
      appliedAt: number | null
    }>

    const out: AgentConfigOverrideRecord[] = []
    for (const row of rows) {
      const path = SettingsStore.parseCell<string[]>(row.path)
      const desiredValue = row.desiredValue === null
        ? undefined
        : SettingsStore.parseCell<AgentConfigValue>(row.desiredValue)
      // JSON `null` is a valid desired value, while parseCell returns undefined
      // only for an absent/invalid cell. Preserve the distinction explicitly.
      const desired = row.desiredValue === 'null' ? null : desiredValue
      if (!path?.length || (row.operation === 'set' && desired === undefined)) continue
      const baselineValue = row.baselineValue === 'null'
        ? null
        : SettingsStore.parseCell<AgentConfigValue>(row.baselineValue)
      const lastAppliedValue = row.lastAppliedValue === 'null'
        ? null
        : SettingsStore.parseCell<AgentConfigValue>(row.lastAppliedValue)
      out.push({
        provider: row.provider,
        scope: row.scope,
        targetId: row.targetId,
        surface: row.surface,
        settingId: row.settingId,
        path,
        operation: row.operation,
        ...(row.operation === 'set' ? { desiredValue: desired as AgentConfigValue } : {}),
        ownership: row.ownership,
        baselinePresent: row.baselinePresent === 1,
        ...(row.baselineValue !== null && baselineValue !== undefined ? { baselineValue } : {}),
        catalogVersion: row.catalogVersion,
        ...(row.lastAppliedValue !== null && lastAppliedValue !== undefined ? { lastAppliedValue } : {}),
        ...(row.lastAppliedHash ? { lastAppliedHash: row.lastAppliedHash } : {}),
        status: row.status,
        ...(row.lastError ? { lastError: row.lastError } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.appliedAt !== null ? { appliedAt: row.appliedAt } : {})
      })
    }
    return out
  }

  saveAgentConfigOverride(row: AgentConfigOverrideRecord): void {
    this.db
      .prepare(
        `INSERT INTO app_agent_config_overrides (
           provider, scope, target_id, surface, setting_id, path, operation, desired_value,
           ownership, baseline_present, baseline_value, catalog_version,
           last_applied_value, last_applied_hash, status, last_error,
           created_at, updated_at, applied_at
         ) VALUES (
           @provider, @scope, @targetId, @surface, @settingId, @path, @operation, @desiredValue,
           @ownership, @baselinePresent, @baselineValue, @catalogVersion,
           @lastAppliedValue, @lastAppliedHash, @status, @lastError,
           @createdAt, @updatedAt, @appliedAt
         )
         ON CONFLICT(provider, scope, target_id, surface, setting_id) DO UPDATE SET
           path = excluded.path,
           operation = excluded.operation,
           desired_value = excluded.desired_value,
           ownership = excluded.ownership,
           baseline_present = excluded.baseline_present,
           baseline_value = excluded.baseline_value,
           catalog_version = excluded.catalog_version,
           last_applied_value = excluded.last_applied_value,
           last_applied_hash = excluded.last_applied_hash,
           status = excluded.status,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at,
           applied_at = excluded.applied_at`
      )
      .run({
        ...row,
        path: JSON.stringify(row.path),
        // Keep a JSON null sentinel for `unset`; it also tolerates a pre-release
        // table whose desired_value column was created NOT NULL.
        desiredValue: row.operation === 'set' ? JSON.stringify(row.desiredValue) : 'null',
        baselinePresent: row.baselinePresent ? 1 : 0,
        baselineValue: row.baselinePresent ? JSON.stringify(row.baselineValue ?? null) : null,
        lastAppliedValue: row.lastAppliedValue === undefined ? null : JSON.stringify(row.lastAppliedValue),
        lastAppliedHash: row.lastAppliedHash ?? null,
        lastError: row.lastError ?? null,
        appliedAt: row.appliedAt ?? null
      })
  }

  removeAgentConfigOverride(key: {
    provider: AgentConfigProviderId
    scope: AgentConfigScope
    targetId: string
    surface: AgentConfigSurface
    settingId: string
  }): void {
    this.db
      .prepare(
        `DELETE FROM app_agent_config_overrides
          WHERE provider = @provider AND scope = @scope AND target_id = @targetId
            AND surface = @surface AND setting_id = @settingId`
      )
      .run(key)
  }

  removeAgentConfigTarget(scope: AgentConfigScope, targetId: string): void {
    this.db
      .prepare('DELETE FROM app_agent_config_overrides WHERE scope = ? AND target_id = ?')
      .run(scope, targetId)
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
      .prepare('SELECT id, name, host, platform, user, port, identity_hint AS identityHint FROM app_remotes ORDER BY name')
      .all() as Array<Omit<RemoteHost, 'platform'> & { platform: string | null; user: string | null; port: number | null; identityHint: string | null }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      platform: r.platform === 'posix' ? 'posix' : undefined,
      user: r.user ?? undefined,
      port: r.port ?? undefined,
      identityHint: r.identityHint ?? undefined
    }))
  }

  saveRemote(remote: RemoteHost & { platform: 'posix' }): void {
    this.db
      .prepare(
        `INSERT INTO app_remotes (id, name, host, platform, user, port, identity_hint)
         VALUES (@id, @name, @host, @platform, @user, @port, @identityHint)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host,
           platform = excluded.platform, user = excluded.user, port = excluded.port,
           identity_hint = excluded.identity_hint`
      )
      .run({
        id: remote.id,
        name: remote.name,
        host: remote.host,
        platform: remote.platform,
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
