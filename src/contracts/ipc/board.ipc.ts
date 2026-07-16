// The board (Phase-3/05, rebuilt as Board v2): BOARDS are keyed by PROJECT — the
// repo root for a git checkout (a linked worktree resolves to its parent repo, so
// every agent worktree shares its project's board), the plain folder otherwise.
// Cards carry flow metadata and a REVISION for optimistic concurrency: the main
// process is the single writer, every write is a field-level patch, and a stale
// `expectedRevision` is refused with the fresh card — a concurrent edit is never
// silently lost. Card text is USER CONTENT — it lives in the local app db and
// NOTHING else: never telemetry, never notify payloads, never logs (ADR 0005).

export const BOARD_LANES = ['backlog', 'todo', 'doing', 'review', 'done'] as const
export type BoardLane = (typeof BOARD_LANES)[number]

export const BOARD_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type BoardPriority = (typeof BOARD_PRIORITIES)[number]

/** Caps enforced at the ONE writer (main). Restated nowhere else. */
export const BOARD_LIMITS = {
  title: 500,
  notes: 10000,
  labels: 8,
  labelLength: 24,
  blockedReason: 500,
  activityPerCard: 200
} as const

export interface BoardCard {
  id: string
  boardId: string
  title: string
  notes: string
  lane: BoardLane
  /** Within-lane sort key (fractional, server-assigned; smaller sorts first). */
  position: number
  /** Optimistic-concurrency stamp — bumped by every accepted write. */
  revision: number
  priority: BoardPriority
  labels: string[]
  blocked: boolean
  blockedReason?: string | null
  dueAt?: number | null
  /** Archived cards leave the lanes but stay queryable (agents archive, never delete). */
  archivedAt?: number | null
  /** The pane WORKING this card — set by launch or an agent's claim, cleared when
   *  the pane dies. One concept: whoever holds it owns the card's mutations. */
  paneId?: number | null
  workspaceId?: string | null
  /** The isolated worktree branch a launch created (mogging/<slug>) — lets the
   *  approval chip and PR auto-link survive the pane. */
  branch?: string | null
  createdAt: number
  updatedAt: number
}

/** Field-level patch: omitted fields stay untouched. The server applies, bumps
 *  `revision`, stamps `updatedAt`, and records activity. */
export interface BoardCardPatch {
  title?: string
  notes?: string
  lane?: BoardLane
  priority?: BoardPriority
  labels?: string[]
  blocked?: boolean
  blockedReason?: string | null
  dueAt?: number | null
  archivedAt?: number | null
  paneId?: number | null
  workspaceId?: string | null
  branch?: string | null
  /** Reorder: place before this card id (must sit in the destination lane);
   *  null/absent = keep position (or append on a lane change). */
  beforeId?: string | null
}

export interface BoardCreateRequest {
  boardId: string
  title: string
  notes?: string
  lane?: BoardLane
  priority?: BoardPriority
  labels?: string[]
  /** Attribution for the activity log — see BoardPatchRequest.actor. */
  actor?: string
}

export interface BoardPatchRequest {
  id: string
  /** When present the write is refused (`conflict`) unless it matches — the UI
   *  always sends it; agents may omit and take field-level last-write-wins. */
  expectedRevision?: number
  patch: BoardCardPatch
  /** Activity attribution: 'human' (default) · 'pane <id>' · 'queue' · 'sync'. */
  actor?: string
}

export type BoardWriteRefusal = 'conflict' | 'unknown-card' | 'invalid' | 'claimed'
export type BoardPatchResult =
  | { ok: true; card: BoardCard }
  | { ok: false; reason: BoardWriteRefusal; card?: BoardCard }

/** One activity-log line: who did what to a card, when. LOCAL user content —
 *  the same custody class as the card itself (ADR 0005). */
export interface BoardActivity {
  id: number
  cardId: string
  ts: number
  actor: string
  verb: string
  detail: string
}

// ── The board entity ─────────────────────────────────────────────────────────

/** The projectKey of the one catch-all board for cards that predate boards or
 *  whose workspace is gone. Never matches a real directory. */
export const UNFILED_PROJECT_KEY = '::unfiled'

export interface BoardQueueConfig {
  /** Default OFF — enabling is an explicit, risk-acknowledged human act. */
  enabled: boolean
  /** Concurrent queue-launched agents (1..4). */
  maxConcurrent: number
  /** Hard launch budget per rolling hour (1..20) — enforced by the engine. */
  launchesPerHour: number
  /** The provider the queue launches (an installed agent CLI id). */
  provider: string
  /** Epoch-ms timestamps of recent queue launches (the budget window's data). */
  launches: number[]
  /** Set when the engine paused itself (consecutive failed launches); the
   *  human resumes by re-enabling. Holds the reason, verbatim, for the banner. */
  pausedReason?: string | null
  /** When the human acknowledged the risk confirm (epoch ms). */
  ackAt?: number | null
}

export interface BoardRulesConfig {
  /** A linked PR's merge moves the card to Done (default OFF). */
  prMergedToDone: boolean
  /** A linked issue's close moves the card to Done (default OFF). */
  issueClosedToDone: boolean
  /** Entering Review looks up the PR for the card's branch and links it (default OFF). */
  autoLinkPr: boolean
}

export interface BoardConfig {
  /** Per-lane WIP limits; absent/0 = no limit for that lane. */
  wip: Partial<Record<BoardLane, number>>
  /** Days without activity before a non-done card wears the aging cue (0 = off). */
  agingDays: number
  /** Days after which Done cards auto-archive (0 = off). */
  autoArchiveDays: number
  rules: BoardRulesConfig
  github: {
    /** Board→GitHub mutations (create/close issues) — default OFF, its own
     *  risk-confirmed grant (ADR 0015). Reads never need it. */
    writeBack: boolean
  }
  queue: BoardQueueConfig
}

export interface Board {
  id: string
  name: string
  /** Canonical project identity: repo root / folder path, or UNFILED_PROJECT_KEY. */
  projectKey: string
  /** GitHub remote as "owner/repo" once detected; null until then. */
  repoRef: string | null
  config: BoardConfig
  createdAt: number
  updatedAt: number
}

/** A switcher row: the board plus its live (non-archived) card count. */
export interface BoardListing {
  board: Board
  cards: number
}

export const defaultBoardQueueConfig = (): BoardQueueConfig => ({
  enabled: false,
  maxConcurrent: 2,
  launchesPerHour: 6,
  provider: '',
  launches: [],
  pausedReason: null,
  ackAt: null
})

export const defaultBoardConfig = (): BoardConfig => ({
  wip: {},
  agingDays: 3,
  autoArchiveDays: 14,
  rules: { prMergedToDone: false, issueClosedToDone: false, autoLinkPr: false },
  github: { writeBack: false },
  queue: defaultBoardQueueConfig()
})

/** Meta/config patch for one board (name, repo binding, config knobs). */
export interface BoardMetaPatch {
  name?: string
  repoRef?: string | null
  config?: Partial<BoardConfig>
}

// ── GitHub (M4) request/result shapes ────────────────────────────────────────

export type BoardGhResult =
  | { ok: true; ref?: string; created?: number; repoRef?: string }
  | { ok: false; reason: string }
