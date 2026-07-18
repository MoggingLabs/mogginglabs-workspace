import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  appendPosition,
  foldProjectKey,
  insertPosition,
  projectKeyForCwd,
  rebalancedPositions,
  sanitizeBoardConfig,
  sanitizeLabels,
  sanitizeLane,
  sanitizePriority
} from '@backend/features/workspace'
import {
  BOARD_LIMITS,
  BoardChannels,
  UNFILED_PROJECT_KEY,
  defaultBoardConfig,
  type Board,
  type BoardCard,
  type BoardCardPatch,
  type BoardConfig,
  type BoardCreateRequest,
  type BoardLane,
  type BoardListing,
  type BoardMetaPatch,
  type BoardPatchRequest,
  type BoardPatchResult
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
import { emitBridgeEvent } from './event-bridge'
import { workspaceIdForPane } from './integrations'

// Board v2 app-wiring: THE one writer. Every mutation — the UI's, an agent's, a
// rule's, the queue's — lands here, serialized by the main process and better-
// sqlite3's synchronous statements, so "the board owns tasks" is a property of
// the architecture, not a convention. Writes are field-level patches with an
// optional revision check (CAS): a stale writer is refused WITH the fresh card,
// never silently clobbered. Card text is USER CONTENT — this file must never
// forward it to telemetry, notify payloads, or logs (ADR 0005); the activity
// log lives in the same local db and custody class as the cards themselves.

let winGetter: (() => BrowserWindow | null) | null = null

/** Every accepted write ends here: the renderer reloads the touched board. */
function broadcast(boardId: string): void {
  try {
    winGetter?.()?.webContents.send(BoardChannels.changed, { boardId })
  } catch {
    /* window gone */
  }
}

// ── Project identity ──────────────────────────────────────────────────────────
// Lives in @backend/features/workspace/project-identity.ts since ADR 0018: the brain
// resolves projects with the SAME helper (extracted, not forked), so a worktree's
// brain and its board can never disagree about which project they belong to.

export { projectKeyForCwd }

const boardNameFor = (projectKey: string): string =>
  projectKey === UNFILED_PROJECT_KEY ? 'Unfiled' : path.basename(projectKey) || projectKey

// ── Find-or-create + the lazy legacy migration ────────────────────────────────

let migrated = false

/** Pre-v2 rows (board_id NULL) are assigned on the FIRST board access: by their
 *  launch workspace's project when it still resolves, to Unfiled otherwise.
 *  Nothing is deleted; the one global board becomes per-project boards. */
function migrateLegacyCards(): void {
  if (migrated) return
  const store = getSettingsStore()
  if (!store) return
  migrated = true
  const legacy = store.listUnfiledCards()
  if (!legacy.length) return
  const workspaces = store.load().workspaces ?? []
  store.boardTransaction(() => {
    for (const card of legacy) {
      const ws = card.workspaceId ? workspaces.find((w) => w.id === card.workspaceId) : undefined
      const board = ensureBoardForKey(projectKeyForCwd(ws?.cwd ?? ''))
      store.putCard({ ...card, boardId: board.id, position: card.position || appendPosition(maxLanePosition(board.id, card.lane)) })
    }
  })
}

function maxLanePosition(boardId: string, lane: BoardLane): number | undefined {
  const cards = getSettingsStore()?.listCards(boardId) ?? []
  let max: number | undefined
  for (const c of cards) if (c.lane === lane && (max === undefined || c.position > max)) max = c.position
  return max
}

function ensureBoardForKey(projectKey: string): Board {
  const store = getSettingsStore()
  if (!store) throw new Error('the board store is unavailable')
  // Identity is the FOLDED key (Windows paths are case-insensitive); the fast
  // exact lookup first, then the folded scan (boards are few by construction).
  const existing =
    store.findBoardByProjectKey(projectKey) ??
    store.listBoards().find((b) => foldProjectKey(b.projectKey) === foldProjectKey(projectKey)) ??
    null
  if (existing) return existing
  const now = Date.now()
  const board: Board = {
    id: randomUUID().slice(0, 24),
    name: boardNameFor(projectKey),
    projectKey,
    repoRef: null,
    config: defaultBoardConfig(),
    createdAt: now,
    updatedAt: now
  }
  store.insertBoard(board)
  return board
}

/** The board a workspace resolves to (find-or-create; migrates on first touch). */
export function boardForWorkspaceId(workspaceId: string): Board | null {
  const store = getSettingsStore()
  if (!store) return null
  migrateLegacyCards()
  const ws = (store.load().workspaces ?? []).find((w) => w.id === workspaceId)
  return ensureBoardForKey(projectKeyForCwd(ws?.cwd ?? ''))
}

/** The board a PANE resolves to (pane → workspace → project) — the MCP scope. */
export function boardForPane(pane: string): Board | null {
  const wsId = workspaceIdForPane(pane)
  if (!wsId) return null
  return boardForWorkspaceId(wsId)
}

// ── Sanitization (the ONE writer's gate; restated nowhere else) ───────────────

const cleanTitle = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.trim().slice(0, BOARD_LIMITS.title) : undefined

function sanitizePatch(raw: unknown): BoardCardPatch | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const patch: BoardCardPatch = {}
  if (r.title !== undefined) {
    const title = cleanTitle(r.title)
    if (!title) return null // a card cannot lose its title
    patch.title = title
  }
  if (r.notes !== undefined) {
    if (typeof r.notes !== 'string') return null
    patch.notes = r.notes.slice(0, BOARD_LIMITS.notes)
  }
  if (r.lane !== undefined) {
    const lane = sanitizeLane(r.lane)
    if (!lane) return null
    patch.lane = lane
  }
  if (r.priority !== undefined) {
    const priority = sanitizePriority(r.priority)
    if (!priority) return null
    patch.priority = priority
  }
  if (r.labels !== undefined) patch.labels = sanitizeLabels(r.labels)
  if (r.blocked !== undefined) patch.blocked = r.blocked === true
  if (r.blockedReason !== undefined) {
    patch.blockedReason = typeof r.blockedReason === 'string' ? r.blockedReason.slice(0, BOARD_LIMITS.blockedReason) : null
  }
  if (r.dueAt !== undefined) patch.dueAt = Number.isFinite(r.dueAt) ? Number(r.dueAt) : null
  if (r.archivedAt !== undefined) patch.archivedAt = Number.isFinite(r.archivedAt) ? Number(r.archivedAt) : null
  if (r.paneId !== undefined) {
    const paneId = r.paneId == null ? null : Number(r.paneId)
    if (paneId !== null && (!Number.isInteger(paneId) || paneId <= 0)) return null
    patch.paneId = paneId
  }
  if (r.workspaceId !== undefined) {
    patch.workspaceId = typeof r.workspaceId === 'string' ? r.workspaceId.slice(0, 64) : null
  }
  if (r.branch !== undefined) patch.branch = typeof r.branch === 'string' ? r.branch.slice(0, 200) : null
  if (r.beforeId !== undefined) patch.beforeId = typeof r.beforeId === 'string' ? r.beforeId.slice(0, 64) : null
  return patch
}

const cleanActor = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim().slice(0, 40) : ''
  return s || 'human'
}

// ── The write path ────────────────────────────────────────────────────────────

interface ApplyOptions {
  actor: string
  expectedRevision?: number
  /** Agent writes respect the claim: a card worked by ANOTHER live pane refuses
   *  with `claimed` (the ledger's manners). Human writes never blocked. */
  enforceClaimFor?: string
}

function activityFor(card: BoardCard, patch: BoardCardPatch): { verb: string; detail: string }[] {
  const out: { verb: string; detail: string }[] = []
  if (patch.lane !== undefined && patch.lane !== card.lane) out.push({ verb: 'moved', detail: `${card.lane} → ${patch.lane}` })
  const edited: string[] = []
  if (patch.title !== undefined && patch.title !== card.title) edited.push('title')
  if (patch.notes !== undefined && patch.notes !== card.notes) edited.push('notes')
  if (edited.length) out.push({ verb: 'edited', detail: edited.join(', ') })
  if (patch.priority !== undefined && patch.priority !== card.priority) out.push({ verb: 'priority', detail: patch.priority })
  if (patch.labels !== undefined && JSON.stringify(patch.labels) !== JSON.stringify(card.labels)) {
    out.push({ verb: 'labels', detail: patch.labels.join(', ') || '(none)' })
  }
  if (patch.blocked !== undefined && patch.blocked !== card.blocked) {
    out.push({ verb: patch.blocked ? 'blocked' : 'unblocked', detail: (patch.blocked && (patch.blockedReason ?? card.blockedReason)) || '' })
  }
  if (patch.dueAt !== undefined && (patch.dueAt ?? null) !== (card.dueAt ?? null)) {
    out.push({ verb: 'due', detail: patch.dueAt ? new Date(patch.dueAt).toISOString().slice(0, 10) : 'cleared' })
  }
  if (patch.archivedAt !== undefined && !!patch.archivedAt !== !!card.archivedAt) {
    out.push({ verb: patch.archivedAt ? 'archived' : 'restored', detail: '' })
  }
  if (patch.paneId !== undefined && (patch.paneId ?? null) !== (card.paneId ?? null)) {
    out.push({ verb: patch.paneId ? 'claimed' : 'released', detail: patch.paneId ? `pane ${patch.paneId}` : '' })
  }
  return out
}

/**
 * Apply one field-level patch — the ONLY mutation path for existing cards.
 * Runs in a transaction: CAS check, claim check, position policy, activity,
 * revision bump. Returns the fresh card on refusal so no caller re-reads.
 */
export function applyCardPatch(id: string, rawPatch: unknown, opts: ApplyOptions): BoardPatchResult {
  const store = getSettingsStore()
  if (!store) return { ok: false, reason: 'invalid' }
  migrateLegacyCards()
  const patch = sanitizePatch(rawPatch)
  if (!patch) return { ok: false, reason: 'invalid' }
  let movedLanes = false
  let laneBefore: BoardLane | null = null
  const result = store.boardTransaction((): BoardPatchResult => {
    const card = store.getCard(id)
    if (!card) return { ok: false, reason: 'unknown-card' }
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== card.revision) {
      return { ok: false, reason: 'conflict', card }
    }
    if (opts.enforceClaimFor !== undefined) {
      // The claim rule: a card being worked by another pane refuses agent
      // writes (comment/read stay free). A claim whose pane no longer resolves
      // to any workspace is dead — dead claims never block.
      const holder = card.paneId != null ? String(card.paneId) : null
      const holderAlive = holder != null && workspaceIdForPane(holder) !== undefined
      if (holder && holderAlive && holder !== opts.enforceClaimFor) {
        return { ok: false, reason: 'claimed', card }
      }
    }
    const next: BoardCard = { ...card }
    const lane = patch.lane ?? card.lane
    // Position policy: an explicit beforeId places the card; a bare lane change
    // appends; everything else keeps the slot.
    if (patch.beforeId) {
      const siblings = store
        .listCards(card.boardId)
        .filter((c) => c.lane === lane && c.id !== card.id)
      const at = siblings.findIndex((c) => c.id === patch.beforeId)
      if (at < 0) return { ok: false, reason: 'invalid', card }
      const placed = insertPosition(at > 0 ? siblings[at - 1].position : undefined, siblings[at].position)
      if (placed.rebalance) {
        const order = [...siblings.slice(0, at), next, ...siblings.slice(at)]
        const keys = rebalancedPositions(order.length)
        order.forEach((c, i) => {
          if (c.id === next.id) next.position = keys[i]
          else store.putCard({ ...c, position: keys[i] })
        })
      } else {
        next.position = placed.position
      }
    } else if (patch.lane !== undefined && patch.lane !== card.lane) {
      next.position = appendPosition(maxLanePosition(card.boardId, lane))
    }
    const activity = activityFor(card, patch)
    movedLanes = activity.some((a) => a.verb === 'moved')
    if (movedLanes) laneBefore = card.lane
    if (patch.title !== undefined) next.title = patch.title
    if (patch.notes !== undefined) next.notes = patch.notes
    if (patch.lane !== undefined) next.lane = patch.lane
    if (patch.priority !== undefined) next.priority = patch.priority
    if (patch.labels !== undefined) next.labels = patch.labels
    if (patch.blocked !== undefined) next.blocked = patch.blocked
    if (patch.blockedReason !== undefined) next.blockedReason = patch.blockedReason
    if (patch.dueAt !== undefined) next.dueAt = patch.dueAt
    if (patch.archivedAt !== undefined) next.archivedAt = patch.archivedAt
    if (patch.paneId !== undefined) next.paneId = patch.paneId
    if (patch.workspaceId !== undefined) next.workspaceId = patch.workspaceId
    if (patch.branch !== undefined) next.branch = patch.branch
    next.revision = card.revision + 1
    next.updatedAt = Date.now()
    store.putCard(next)
    const ts = Date.now()
    for (const a of activity) store.addBoardActivity({ cardId: card.id, ts, actor: opts.actor, verb: a.verb, detail: a.detail })
    return { ok: true, card: next }
  })
  if (result.ok) {
    broadcast(result.card.boardId)
    if (movedLanes) {
      // The bridge's card-moved (docs/14 §4) — ids only, never card text (ADR 0005).
      emitBridgeEvent('card-moved', { workspace: result.card.workspaceId ?? '', card: result.card.id })
      const from = laneBefore
      for (const cb of laneChangeListeners) {
        try {
          if (from) cb(result.card, from)
        } catch {
          /* a rule failing must never un-move a card */
        }
      }
    }
  }
  return result
}

/** Create one card — server-assigned id, position, revision. */
export function createCard(raw: unknown, actorFallback = 'human'): BoardCard | null {
  const store = getSettingsStore()
  if (!store) return null
  migrateLegacyCards()
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const req: BoardCreateRequest | null = (() => {
    const boardId = typeof r.boardId === 'string' ? r.boardId : ''
    const title = cleanTitle(r.title)
    if (!boardId || !title) return null
    return { boardId, title }
  })()
  if (!req) return null
  if (!store.getBoard(req.boardId)) return null
  const lane = sanitizeLane(r.lane) ?? 'todo'
  const now = Date.now()
  const card: BoardCard = {
    id: randomUUID().slice(0, 36),
    boardId: req.boardId,
    title: req.title,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, BOARD_LIMITS.notes) : '',
    lane,
    position: appendPosition(maxLanePosition(req.boardId, lane)),
    revision: 0,
    priority: sanitizePriority(r.priority) ?? 'normal',
    labels: sanitizeLabels(r.labels),
    blocked: false,
    blockedReason: null,
    dueAt: null,
    archivedAt: null,
    paneId: null,
    workspaceId: null,
    branch: null,
    createdAt: now,
    updatedAt: now
  }
  store.boardTransaction(() => {
    store.putCard(card)
    store.addBoardActivity({ cardId: card.id, ts: now, actor: cleanActor(r.actor ?? actorFallback), verb: 'created', detail: '' })
  })
  broadcast(card.boardId)
  return card
}

/** Lane-change listeners (github-board's auto-link rule rides this). Called
 *  AFTER the write committed — a listener throwing cannot un-move a card. */
const laneChangeListeners = new Set<(card: BoardCard, from: BoardLane) => void>()
export function onCardLaneChange(cb: (card: BoardCard, from: BoardLane) => void): () => void {
  laneChangeListeners.add(cb)
  return () => laneChangeListeners.delete(cb)
}

/** A non-mutating activity note (rules and GitHub verbs narrate themselves). */
export function noteCardActivity(cardId: string, verb: string, detail: string, actor = 'sync'): void {
  const store = getSettingsStore()
  const card = store?.getCard(cardId)
  if (!store || !card) return
  store.addBoardActivity({ cardId, ts: Date.now(), actor: cleanActor(actor), verb: verb.slice(0, 40), detail: detail.slice(0, 500) })
  broadcast(card.boardId)
}

/** A progress comment: one activity entry, no card mutation, no revision bump.
 *  The body is USER CONTENT — it lives in the activity table and nowhere else. */
export function commentCard(cardId: string, body: unknown, actor: string): { ok: true } | { ok: false; reason: 'unknown-card' | 'invalid' } {
  const store = getSettingsStore()
  if (!store) return { ok: false, reason: 'invalid' }
  const text = typeof body === 'string' ? body.trim().slice(0, 2000) : ''
  if (!text) return { ok: false, reason: 'invalid' }
  const card = store.getCard(cardId)
  if (!card) return { ok: false, reason: 'unknown-card' }
  store.addBoardActivity({ cardId, ts: Date.now(), actor: cleanActor(actor), verb: 'comment', detail: text })
  broadcast(card.boardId)
  return { ok: true }
}

/** Done-lane hygiene, applied on read: cards idle past the board's
 *  autoArchiveDays leave the lanes (archived, restorable — never deleted). */
function autoArchive(board: Board): void {
  const days = board.config.autoArchiveDays
  if (!days) return
  const store = getSettingsStore()
  if (!store) return
  const cutoff = Date.now() - days * 86_400_000
  const stale = store.listCards(board.id).filter((c) => c.lane === 'done' && c.updatedAt < cutoff)
  if (!stale.length) return
  store.boardTransaction(() => {
    const ts = Date.now()
    for (const c of stale) {
      store.putCard({ ...c, archivedAt: ts, revision: c.revision + 1, updatedAt: c.updatedAt })
      store.addBoardActivity({ cardId: c.id, ts, actor: 'sync', verb: 'archived', detail: `idle ${days}d in done` })
    }
  })
  broadcast(board.id)
}

/** Board meta/config writes (name, repo binding, WIP/rules/queue knobs). */
export function patchBoardMeta(id: string, raw: unknown): Board | null {
  const store = getSettingsStore()
  if (!store) return null
  const board = store.getBoard(id)
  if (!board) return null
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as BoardMetaPatch & Record<string, unknown>
  const next: Board = { ...board }
  if (typeof r.name === 'string' && r.name.trim()) next.name = r.name.trim().slice(0, 120)
  if (r.repoRef !== undefined) {
    next.repoRef = typeof r.repoRef === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(r.repoRef) ? r.repoRef : null
  }
  if (r.config !== undefined) next.config = sanitizeBoardConfig({ ...boardConfigAsRaw(board.config), ...(r.config as Record<string, unknown>) })
  next.updatedAt = Date.now()
  store.updateBoardRow(next)
  broadcast(next.id)
  return next
}

/** Merge-friendly view of a config (partial patches merge over the stored one). */
const boardConfigAsRaw = (c: BoardConfig): Record<string, unknown> => JSON.parse(JSON.stringify(c)) as Record<string, unknown>

// ── Registration ──────────────────────────────────────────────────────────────

export function registerBoard(getWin: () => BrowserWindow | null): void {
  winGetter = getWin

  ipcMain.handle(BoardChannels.forWorkspace, (_e, raw: unknown) => {
    if (typeof raw === 'string') return boardForWorkspaceId(raw)
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as { workspaceId?: unknown; cwd?: unknown }
    const wsId = typeof r.workspaceId === 'string' ? r.workspaceId : ''
    const liveCwd = typeof r.cwd === 'string' ? r.cwd : ''
    const store = getSettingsStore()
    if (!store) return null
    migrateLegacyCards()
    // The persisted row is canonical — but workspace creation resolves its
    // board BEFORE the debounced state save lands, so the renderer's live cwd
    // covers the gap (same projectKey either way once the row exists).
    const persisted = wsId ? (store.load().workspaces ?? []).find((w) => w.id === wsId)?.cwd : undefined
    return ensureBoardForKey(projectKeyForCwd(persisted ?? liveCwd))
  })
  ipcMain.handle(BoardChannels.boards, (): BoardListing[] => {
    const store = getSettingsStore()
    if (!store) return []
    migrateLegacyCards()
    const counts = store.cardCountsByBoard()
    return store.listBoards().map((board) => ({ board, cards: counts.get(board.id) ?? 0 }))
  })
  ipcMain.handle(BoardChannels.boardPatch, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as { id?: unknown; patch?: unknown }
    return typeof r.id === 'string' ? patchBoardMeta(r.id, r.patch) : null
  })
  ipcMain.handle(BoardChannels.list, async (_e, boardId: unknown) => {
    await maybeFault(BoardChannels.list) // ASYNCSTATE seam (finding 39) — inert unless armed
    const store = getSettingsStore()
    if (!store || typeof boardId !== 'string') return []
    migrateLegacyCards()
    const board = store.getBoard(boardId)
    if (!board) return []
    autoArchive(board)
    return store.listCards(boardId)
  })
  ipcMain.handle(BoardChannels.archived, (_e, boardId: unknown) =>
    typeof boardId === 'string' ? (getSettingsStore()?.listArchivedCards(boardId) ?? []) : []
  )
  ipcMain.handle(BoardChannels.create, async (_e, raw: unknown) => {
    await maybeFault(BoardChannels.create)
    return createCard(raw)
  })
  ipcMain.handle(BoardChannels.patch, async (_e, raw: unknown): Promise<BoardPatchResult> => {
    await maybeFault(BoardChannels.patch)
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<BoardPatchRequest>
    if (typeof r.id !== 'string' || !r.id) return { ok: false, reason: 'unknown-card' }
    return applyCardPatch(r.id, r.patch, {
      actor: cleanActor(r.actor),
      expectedRevision: typeof r.expectedRevision === 'number' ? r.expectedRevision : undefined
    })
  })
  ipcMain.handle(BoardChannels.remove, async (_e, id: unknown) => {
    await maybeFault(BoardChannels.remove)
    const store = getSettingsStore()
    if (!store || typeof id !== 'string' || !id) return
    const card = store.getCard(id)
    store.removeBoardCard(id)
    if (card) broadcast(card.boardId)
  })
  ipcMain.handle(BoardChannels.activity, (_e, cardId: unknown) =>
    typeof cardId === 'string' ? (getSettingsStore()?.listBoardActivity(cardId) ?? []) : []
  )
}

/** Smoke-only handles: direct store writes that still broadcast (BOARDV2 uses
 *  these to prove the push path without riding the renderer's own IPC). */
export function boardDebug(): {
  patchDirect: (id: string, patch: unknown, actor?: string) => BoardPatchResult
  ensureForCwd: (cwd: string) => Board
  projectKey: (cwd: string) => string
  /** Re-run the lazy legacy migration over rows planted AFTER boot (BOARDV2). */
  migrateNow: () => void
} {
  return {
    patchDirect: (id, patch, actor = 'sync') => applyCardPatch(id, patch, { actor }),
    ensureForCwd: (cwd) => {
      migrateLegacyCards()
      return ensureBoardForKey(projectKeyForCwd(cwd))
    },
    projectKey: (cwd) => projectKeyForCwd(cwd),
    migrateNow: () => {
      migrated = false
      migrateLegacyCards()
    }
  }
}
