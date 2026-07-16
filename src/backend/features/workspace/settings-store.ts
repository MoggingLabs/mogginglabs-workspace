// App-level workspace state and non-secret feature-owned desired state, persisted with the
// same better-sqlite3 mechanism as the session store (03). Electron-free. NO credentials
// (ADR 0002). Kept in a SEPARATE db from the daemon's
// sessions.db so the two processes never contend on one file: main owns this; daemon owns sessions.
// better-sqlite3 arrives through the host-aware seam (ADR 0017): this store runs in
// Electron main today, but the seam keeps every consumer of the ABI-bound native honest.
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { requireNative } from '@backend/platform/native-require'
import { addColumnIfMissing } from './db-migrate'
import { parseJsonCell, workspaceMetaToRow, workspaceRowToMeta, type WorkspaceRowCells } from './workspace-rows'
import { boardRowToBoard, cardRowToCard, type BoardCardRowCells, type BoardRowCells } from './board-rows'

const Database = requireNative<typeof import('better-sqlite3')>('better-sqlite3')
import {
  BOARD_LIMITS,
  type AgentConfigOverrideRecord,
  type AgentConfigProviderId,
  type AgentConfigScope,
  type AgentConfigSurface,
  type AgentConfigSyncState,
  type AgentConfigValue,
  type AgentProfile,
  type Board,
  type BoardActivity,
  type BoardCard,
  type ProviderCount,
  type ProviderMixTemplate,
  type RecentWorkspace,
  type RemoteHost,
  type WorkspaceState,
  type WorkspaceStateMeta
} from '@contracts'

export class SettingsStore {
  private readonly db: BetterSqlite3.Database

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
        identity_hint TEXT,
        -- The confirmed dialect of the far side. Legacy rows are NULL and read back as
        -- posix/sh; a windows host also names its shell (powershell/cmd).
        platform TEXT,
        shell TEXT
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
      -- Board v2: boards keyed by PROJECT (repo root / folder). One row per
      -- project; cards join via app_board.board_id (additive column below).
      CREATE TABLE IF NOT EXISTS app_boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_key TEXT NOT NULL UNIQUE,
        repo_ref TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Per-card activity log (who did what, when) — LOCAL user content, the
      -- card's own custody class (ADR 0005); capped per card on insert.
      CREATE TABLE IF NOT EXISTS app_board_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        verb TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS app_board_activity_card_idx
        ON app_board_activity (card_id, id);
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
    // Additive column migrations (idempotent — see db-migrate.ts). In arrival order:
    //   assignments        pre-06b: per-workspace template lineup
    //   pane_cwds          pre-3/03: per-slot cwd overrides (worktree isolation)
    //   pane_roles         pre-4/01: per-slot swarm roles
    //   pane_remotes       pre-4/05: per-slot remote hosts
    //   pane_profile_ids   pre-6/04: per-slot launch profiles (ids only — ADR 0002)
    //   layout_tree        pre-split-tree: serialized pane arrangement (shape + sizes)
    //   pane_ids           pre-move-persistence: per-slot pane-id overrides for panes
    //                      MOVED between workspaces. The contract carried the field and
    //                      restore consumed it, but no column existed — so a moved pane's
    //                      daemon session was silently orphaned on every app restart.
    for (const [column, type] of [
      ['assignments', 'TEXT'],
      ['pane_cwds', 'TEXT'],
      ['pane_roles', 'TEXT'],
      ['pane_remotes', 'TEXT'],
      ['pane_profile_ids', 'TEXT'],
      ['layout_tree', 'TEXT'],
      ['pane_ids', 'TEXT']
    ] as const) {
      addColumnIfMissing(this.db, 'app_workspaces', column, type)
    }
    // Board v2 (additive; pre-v2 rows read back with board_id NULL until the
    // lazy migration in main assigns them — see main/board.ts):
    //   board_id      which board owns the card (app_boards.id)
    //   revision      optimistic-concurrency stamp, bumped per accepted write
    //   priority / labels / blocked / blocked_reason / due_at  flow metadata
    //   archived_at   archived cards leave the lanes but stay queryable
    //   branch        the launch's worktree branch (mogging/<slug>)
    for (const [column, type] of [
      ['board_id', 'TEXT'],
      ['revision', 'INTEGER NOT NULL DEFAULT 0'],
      ['priority', 'TEXT'],
      ['labels', 'TEXT'],
      ['blocked', 'INTEGER NOT NULL DEFAULT 0'],
      ['blocked_reason', 'TEXT'],
      ['due_at', 'INTEGER'],
      ['archived_at', 'INTEGER'],
      ['branch', 'TEXT']
    ] as const) {
      addColumnIfMissing(this.db, 'app_board', column, type)
    }
    // Simplified profiles: the subscription email (a label — ADR 0002).
    addColumnIfMissing(this.db, 'app_profiles', 'email', 'TEXT')
    // Development builds predating ADR 0011's explicit set/unset distinction.
    addColumnIfMissing(this.db, 'app_agent_config_overrides', 'operation', "TEXT NOT NULL DEFAULT 'set'")
    // Remote bootstrapping was POSIX-only: existing rows are NULL/unconfirmed and stay that
    // way until the user confirms the dialect (which may now be windows) in Settings.
    // No CHECK constraint here — an old db must be able to hold a windows host later.
    addColumnIfMissing(this.db, 'app_remotes', 'platform', 'TEXT')
    addColumnIfMissing(this.db, 'app_remotes', 'shell', 'TEXT')
  }

  load(): WorkspaceState {
    // Row <-> meta mapping lives in workspace-rows.ts (pure, unit-tested) so a contract
    // field the mapping forgets fails a test instead of silently round-tripping as
    // undefined — which is exactly how paneIds got dropped.
    const rows = this.db
      .prepare(
        'SELECT id, name, color, cwd, ordinal, pane_count AS paneCount, layout_tree AS layoutTree, assignments, pane_cwds AS paneCwds, pane_roles AS paneRoles, pane_remotes AS paneRemotes, pane_profile_ids AS paneProfileIds, pane_ids AS paneIds FROM app_workspaces ORDER BY position'
      )
      .all() as WorkspaceRowCells[]
    const workspaces: WorkspaceStateMeta[] = rows.map(workspaceRowToMeta)
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
        'INSERT INTO app_workspaces (id, name, color, cwd, ordinal, pane_count, layout_tree, position, assignments, pane_cwds, pane_roles, pane_remotes, pane_profile_ids, pane_ids) VALUES (@id, @name, @color, @cwd, @ordinal, @paneCount, @layoutTree, @position, @assignments, @paneCwds, @paneRoles, @paneRemotes, @paneProfileIds, @paneIds)'
      )
      s.workspaces.forEach((w, i) => ins.run({ ...workspaceMetaToRow(w), position: i }))
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
      const path = parseJsonCell<string[]>(row.path)
      const desiredValue = row.desiredValue === null
        ? undefined
        : parseJsonCell<AgentConfigValue>(row.desiredValue)
      // JSON `null` is a valid desired value, while parseCell returns undefined
      // only for an absent/invalid cell. Preserve the distinction explicitly.
      const desired = row.desiredValue === 'null' ? null : desiredValue
      if (!path?.length || (row.operation === 'set' && desired === undefined)) continue
      const baselineValue = row.baselineValue === 'null'
        ? null
        : parseJsonCell<AgentConfigValue>(row.baselineValue)
      const lastAppliedValue = row.lastAppliedValue === 'null'
        ? null
        : parseJsonCell<AgentConfigValue>(row.lastAppliedValue)
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

  // ── Board v2 (Phase-3/05, rebuilt). Card text is USER CONTENT: these local
  // tables are its ONLY home — board rows never feed telemetry, notify, or logs
  // (ADR 0005). This layer is DUMB ROWS: sanitization, CAS, and position policy
  // live in main/board.ts, the one writer. ──────────────────────────────────────

  private static readonly CARD_COLUMNS =
    'id, board_id AS boardId, title, notes, lane, position, revision, priority, labels, ' +
    'blocked, blocked_reason AS blockedReason, due_at AS dueAt, archived_at AS archivedAt, ' +
    'pane_id AS paneId, workspace_id AS workspaceId, branch, created_at AS createdAt, updated_at AS updatedAt'

  private static readonly BOARD_COLUMNS =
    'id, name, project_key AS projectKey, repo_ref AS repoRef, config, created_at AS createdAt, updated_at AS updatedAt'

  listBoards(): Board[] {
    const rows = this.db
      .prepare(`SELECT ${SettingsStore.BOARD_COLUMNS} FROM app_boards ORDER BY created_at`)
      .all() as BoardRowCells[]
    return rows.map(boardRowToBoard)
  }

  getBoard(id: string): Board | null {
    const row = this.db
      .prepare(`SELECT ${SettingsStore.BOARD_COLUMNS} FROM app_boards WHERE id = ?`)
      .get(id) as BoardRowCells | undefined
    return row ? boardRowToBoard(row) : null
  }

  findBoardByProjectKey(projectKey: string): Board | null {
    const row = this.db
      .prepare(`SELECT ${SettingsStore.BOARD_COLUMNS} FROM app_boards WHERE project_key = ?`)
      .get(projectKey) as BoardRowCells | undefined
    return row ? boardRowToBoard(row) : null
  }

  insertBoard(board: Board): void {
    this.db
      .prepare(
        `INSERT INTO app_boards (id, name, project_key, repo_ref, config, created_at, updated_at)
         VALUES (@id, @name, @projectKey, @repoRef, @config, @createdAt, @updatedAt)`
      )
      .run({
        id: board.id,
        name: board.name,
        projectKey: board.projectKey,
        repoRef: board.repoRef ?? null,
        config: JSON.stringify(board.config),
        createdAt: board.createdAt,
        updatedAt: board.updatedAt
      })
  }

  updateBoardRow(board: Board): void {
    this.db
      .prepare(
        'UPDATE app_boards SET name = @name, repo_ref = @repoRef, config = @config, updated_at = @updatedAt WHERE id = @id'
      )
      .run({
        id: board.id,
        name: board.name,
        repoRef: board.repoRef ?? null,
        config: JSON.stringify(board.config),
        updatedAt: board.updatedAt
      })
  }

  /** Live (non-archived) cards of one board, lane-order ready (position, then age). */
  listCards(boardId: string): BoardCard[] {
    const rows = this.db
      .prepare(
        `SELECT ${SettingsStore.CARD_COLUMNS} FROM app_board WHERE board_id = ? AND archived_at IS NULL ORDER BY position, created_at`
      )
      .all(boardId) as BoardCardRowCells[]
    return rows.map(cardRowToCard)
  }

  listArchivedCards(boardId: string): BoardCard[] {
    const rows = this.db
      .prepare(
        `SELECT ${SettingsStore.CARD_COLUMNS} FROM app_board WHERE board_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC`
      )
      .all(boardId) as BoardCardRowCells[]
    return rows.map(cardRowToCard)
  }

  /** Every live card across every board — the paneless MCP overview read. */
  listAllCards(): BoardCard[] {
    const rows = this.db
      .prepare(
        `SELECT ${SettingsStore.CARD_COLUMNS} FROM app_board WHERE archived_at IS NULL ORDER BY board_id, position, created_at`
      )
      .all() as BoardCardRowCells[]
    return rows.map(cardRowToCard)
  }

  getCard(id: string): BoardCard | null {
    const row = this.db
      .prepare(`SELECT ${SettingsStore.CARD_COLUMNS} FROM app_board WHERE id = ?`)
      .get(id) as BoardCardRowCells | undefined
    return row ? cardRowToCard(row) : null
  }

  /** Full-row write (insert or replace by id). The caller (main) owns revision
   *  bumps and sanitization; the row is stored verbatim. */
  putCard(card: BoardCard): void {
    this.db
      .prepare(
        `INSERT INTO app_board (id, board_id, title, notes, lane, position, revision, priority, labels,
           blocked, blocked_reason, due_at, archived_at, pane_id, workspace_id, branch, created_at, updated_at)
         VALUES (@id, @boardId, @title, @notes, @lane, @position, @revision, @priority, @labels,
           @blocked, @blockedReason, @dueAt, @archivedAt, @paneId, @workspaceId, @branch, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           board_id = excluded.board_id, title = excluded.title, notes = excluded.notes,
           lane = excluded.lane, position = excluded.position, revision = excluded.revision,
           priority = excluded.priority, labels = excluded.labels, blocked = excluded.blocked,
           blocked_reason = excluded.blocked_reason, due_at = excluded.due_at,
           archived_at = excluded.archived_at, pane_id = excluded.pane_id,
           workspace_id = excluded.workspace_id, branch = excluded.branch,
           updated_at = excluded.updated_at`
      )
      .run({
        id: card.id,
        boardId: card.boardId,
        title: card.title,
        notes: card.notes,
        lane: card.lane,
        position: card.position,
        revision: card.revision,
        priority: card.priority,
        labels: JSON.stringify(card.labels),
        blocked: card.blocked ? 1 : 0,
        blockedReason: card.blockedReason ?? null,
        dueAt: card.dueAt ?? null,
        archivedAt: card.archivedAt ?? null,
        paneId: card.paneId ?? null,
        workspaceId: card.workspaceId ?? null,
        branch: card.branch ?? null,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt
      })
  }

  removeBoardCard(id: string): void {
    this.db.prepare('DELETE FROM app_board WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM app_board_activity WHERE card_id = ?').run(id)
  }

  /** Cards predating Board v2 (board_id NULL) — the lazy migration's worklist. */
  listUnfiledCards(): BoardCard[] {
    const rows = this.db
      .prepare(`SELECT ${SettingsStore.CARD_COLUMNS} FROM app_board WHERE board_id IS NULL ORDER BY created_at`)
      .all() as BoardCardRowCells[]
    return rows.map(cardRowToCard)
  }

  /** Live card counts per board, one query — the switcher's badge source. */
  cardCountsByBoard(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT board_id AS boardId, COUNT(*) AS n FROM app_board WHERE archived_at IS NULL GROUP BY board_id')
      .all() as { boardId: string | null; n: number }[]
    const out = new Map<string, number>()
    for (const r of rows) if (r.boardId) out.set(r.boardId, r.n)
    return out
  }

  addBoardActivity(entry: { cardId: string; ts: number; actor: string; verb: string; detail: string }): void {
    this.db
      .prepare('INSERT INTO app_board_activity (card_id, ts, actor, verb, detail) VALUES (@cardId, @ts, @actor, @verb, @detail)')
      .run(entry)
    // Cap per card ON INSERT — the log can never grow unbounded (ADR 0005 posture:
    // local, bounded, clearable with its card).
    this.db
      .prepare(
        `DELETE FROM app_board_activity WHERE card_id = @cardId AND id NOT IN (
           SELECT id FROM app_board_activity WHERE card_id = @cardId ORDER BY id DESC LIMIT @keep)`
      )
      .run({ cardId: entry.cardId, keep: BOARD_LIMITS.activityPerCard })
  }

  listBoardActivity(cardId: string, limit = 50): BoardActivity[] {
    return this.db
      .prepare(
        'SELECT id, card_id AS cardId, ts, actor, verb, detail FROM app_board_activity WHERE card_id = ? ORDER BY id DESC LIMIT ?'
      )
      .all(cardId, Math.max(1, Math.min(200, limit))) as BoardActivity[]
  }

  /** One transaction wrapper for main's compound writes (CAS read + write + activity). */
  boardTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /** Smoke-only (BOARDV2's migration bite): a pre-v2 row EXACTLY as the old
   *  writer left it — board_id NULL, none of the v2 columns touched. */
  plantLegacyBoardCardForSmoke(card: {
    id: string
    title: string
    notes: string
    lane: string
    paneId: number | null
    workspaceId: string | null
    createdAt: number
    updatedAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO app_board (id, title, notes, lane, pane_id, workspace_id, created_at, updated_at)
         VALUES (@id, @title, @notes, @lane, @paneId, @workspaceId, @createdAt, @updatedAt)`
      )
      .run(card)
  }

  // ── Remote hosts (Phase-4/05): connection POINTERS; auth is the user's ssh stack. ──
  listRemotes(): RemoteHost[] {
    const rows = this.db
      .prepare('SELECT id, name, host, user, port, identity_hint AS identityHint, platform, shell FROM app_remotes ORDER BY name')
      .all() as Array<
        Omit<RemoteHost, 'platform' | 'shell'> & {
          platform: string | null
          shell: string | null
          user: string | null
          port: number | null
          identityHint: string | null
        }
      >
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      user: r.user ?? undefined,
      port: r.port ?? undefined,
      // A legacy row (platform NULL, written before the column existed) confirmed NOTHING, and the
      // read path must not confirm it on the user's behalf: coercing NULL to 'posix' is a guess
      // about someone else's machine, and the whole point of the union is that guessing an OS and
      // then typing at it is how a bash-ism lands in a PowerShell. Unconfirmed stays undefined
      // until the user picks; `shell` follows the platform it belongs to.
      platform: r.platform === 'windows' ? 'windows' : r.platform === 'posix' ? 'posix' : undefined,
      shell:
        r.platform === null
          ? undefined
          : ((r.shell ?? (r.platform === 'windows' ? 'powershell' : 'sh')) as RemoteHost['shell']),
      identityHint: r.identityHint ?? undefined
    }))
  }

  saveRemote(remote: RemoteHost): void {
    this.db
      .prepare(
        `INSERT INTO app_remotes (id, name, host, user, port, identity_hint, platform, shell)
         VALUES (@id, @name, @host, @user, @port, @identityHint, @platform, @shell)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host,
           user = excluded.user, port = excluded.port, identity_hint = excluded.identity_hint,
           platform = excluded.platform, shell = excluded.shell`
      )
      .run({
        id: remote.id,
        name: remote.name,
        host: remote.host,
        user: remote.user ?? null,
        port: remote.port ?? null,
        // NULL stays NULL — the write path must honor the same rule as the read path
        // above: an unconfirmed platform is a fact about the user's knowledge, and
        // coercing it to 'posix' here CONFIRMED it on their behalf (any round-trip
        // save — a rename, a port edit — silently stamped a legacy host POSIX, which
        // is exactly the guess listRemotes refuses to make).
        platform: remote.platform ?? null,
        shell: remote.platform === undefined ? null : (remote.shell ?? (remote.platform === 'windows' ? 'powershell' : 'sh')),
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
      env: parseJsonCell<Record<string, string>>(r.env) ?? {}
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

  /** Make one profile order-0 atomically. Two renderer clicks can never leave both
   * profiles half-swapped or lose a concurrent edit between separate saves. */
  activateProfile(provider: string, profileId: string): AgentProfile | null {
    const tx = this.db.transaction(() => {
      const mine = this.listProfiles().filter((profile) => profile.provider === provider).sort((a, b) => a.order - b.order)
      const target = mine.find((profile) => profile.id === profileId)
      const current = mine[0]
      if (!target || !current) return null
      if (target.id !== current.id) {
        const update = this.db.prepare('UPDATE app_profiles SET ord = ? WHERE id = ? AND provider = ?')
        update.run(current.order, target.id, provider)
        update.run(target.order, current.id, provider)
      }
      return target
    })
    return tx()
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
      .map((r) => ({ id: r.id, name: r.name, mix: parseJsonCell<ProviderCount[]>(r.mix) }))
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
