import {
  BOARD_LANES,
  BOARD_LIMITS,
  BOARD_PRIORITIES,
  defaultBoardConfig,
  defaultBoardQueueConfig,
  type Board,
  type BoardCard,
  type BoardConfig,
  type BoardLane,
  type BoardPriority
} from '@contracts'
import { parseJsonCell } from './workspace-rows'

// The PURE half of Board-v2 persistence: row <-> contract mapping, config
// sanitization, and the within-lane position math — no sqlite in sight, so the
// unit tier (tests/unit/board-rows.test.ts) bites on exactly the logic that
// guards the board's concurrency and ordering promises. The store stays dumb
// rows; main stays the one writer.

/** One card row as SELECTed (aliased to camelCase; JSON-encoded list cells). */
export interface BoardCardRowCells {
  id: string
  boardId: string | null
  title: string
  notes: string
  lane: string
  position: number
  revision: number
  priority: string | null
  labels: string | null
  blocked: number | null
  blockedReason: string | null
  dueAt: number | null
  archivedAt: number | null
  paneId: number | null
  workspaceId: string | null
  branch: string | null
  createdAt: number
  updatedAt: number
}

export interface BoardRowCells {
  id: string
  name: string
  projectKey: string
  repoRef: string | null
  config: string | null
  createdAt: number
  updatedAt: number
}

export const sanitizeLane = (v: unknown): BoardLane | undefined =>
  typeof v === 'string' && (BOARD_LANES as readonly string[]).includes(v) ? (v as BoardLane) : undefined

export const sanitizePriority = (v: unknown): BoardPriority | undefined =>
  typeof v === 'string' && (BOARD_PRIORITIES as readonly string[]).includes(v) ? (v as BoardPriority) : undefined

/** Labels: trimmed, deduped, each capped, the list capped — never a throw. */
export function sanitizeLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const label = raw.trim().slice(0, BOARD_LIMITS.labelLength)
    if (!label || out.includes(label)) continue
    out.push(label)
    if (out.length >= BOARD_LIMITS.labels) break
  }
  return out
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Merge a stored/patched config over the defaults with every knob clamped —
 *  a corrupt cell degrades to defaults, never throws, never smuggles NaN. */
export function sanitizeBoardConfig(raw: unknown): BoardConfig {
  const def = defaultBoardConfig()
  if (typeof raw !== 'object' || raw === null) return def
  const r = raw as Record<string, unknown>
  const wipRaw = (typeof r.wip === 'object' && r.wip !== null ? r.wip : {}) as Record<string, unknown>
  const wip: Partial<Record<BoardLane, number>> = {}
  for (const lane of BOARD_LANES) {
    const n = clampInt(wipRaw[lane], 0, 99, 0)
    if (n > 0) wip[lane] = n
  }
  const rulesRaw = (typeof r.rules === 'object' && r.rules !== null ? r.rules : {}) as Record<string, unknown>
  const githubRaw = (typeof r.github === 'object' && r.github !== null ? r.github : {}) as Record<string, unknown>
  const queueRaw = (typeof r.queue === 'object' && r.queue !== null ? r.queue : {}) as Record<string, unknown>
  const defQueue = defaultBoardQueueConfig()
  const launches = Array.isArray(queueRaw.launches)
    ? queueRaw.launches.filter((t): t is number => Number.isFinite(t)).slice(-100)
    : []
  return {
    wip,
    agingDays: clampInt(r.agingDays, 0, 60, def.agingDays),
    autoArchiveDays: clampInt(r.autoArchiveDays, 0, 365, def.autoArchiveDays),
    rules: {
      prMergedToDone: rulesRaw.prMergedToDone === true,
      issueClosedToDone: rulesRaw.issueClosedToDone === true,
      autoLinkPr: rulesRaw.autoLinkPr === true
    },
    github: { writeBack: githubRaw.writeBack === true },
    queue: {
      enabled: queueRaw.enabled === true,
      maxConcurrent: clampInt(queueRaw.maxConcurrent, 1, 4, defQueue.maxConcurrent),
      launchesPerHour: clampInt(queueRaw.launchesPerHour, 1, 20, defQueue.launchesPerHour),
      provider: typeof queueRaw.provider === 'string' ? queueRaw.provider.slice(0, 64) : '',
      launches,
      pausedReason:
        typeof queueRaw.pausedReason === 'string' && queueRaw.pausedReason
          ? queueRaw.pausedReason.slice(0, 200)
          : null,
      ackAt: Number.isFinite(queueRaw.ackAt) ? Number(queueRaw.ackAt) : null
    }
  }
}

export function cardRowToCard(r: BoardCardRowCells): BoardCard {
  return {
    id: r.id,
    boardId: r.boardId ?? '',
    title: r.title,
    notes: r.notes,
    lane: sanitizeLane(r.lane) ?? 'todo',
    position: Number.isFinite(r.position) ? r.position : 0,
    revision: Number.isFinite(r.revision) ? r.revision : 0,
    priority: sanitizePriority(r.priority) ?? 'normal',
    labels: sanitizeLabels(parseJsonCell<string[]>(r.labels) ?? []),
    blocked: r.blocked === 1,
    blockedReason: r.blockedReason ?? null,
    dueAt: r.dueAt ?? null,
    archivedAt: r.archivedAt ?? null,
    paneId: r.paneId ?? null,
    workspaceId: r.workspaceId ?? null,
    branch: r.branch ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

export function boardRowToBoard(r: BoardRowCells): Board {
  return {
    id: r.id,
    name: r.name,
    projectKey: r.projectKey,
    repoRef: r.repoRef ?? null,
    config: sanitizeBoardConfig(parseJsonCell<unknown>(r.config)),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

// ── Position math (within one lane) ──────────────────────────────────────────
// Fractional keys: append = max + GAP; insert = midpoint. When the midpoint
// collapses (repeated same-spot inserts exhaust the float), the caller
// rebalances the lane to GAP strides — positions are private to the server, so
// a rebalance is invisible to every client.

export const POSITION_GAP = 1024
/** Below this gap a midpoint stops being trustworthy — rebalance the lane. */
export const POSITION_EPSILON = 1e-6

export const appendPosition = (maxInLane: number | undefined): number =>
  (maxInLane ?? 0) + POSITION_GAP

/** Position for inserting BEFORE `next`, after `prev` (undefined = lane head).
 *  `rebalance` tells the caller the lane's keys are too dense to midpoint. */
export function insertPosition(
  prev: number | undefined,
  next: number
): { position: number; rebalance: boolean } {
  const lo = prev ?? next - POSITION_GAP
  const position = (lo + next) / 2
  const rebalance = !(position > lo && position < next) || next - lo < POSITION_EPSILON
  return { position, rebalance }
}

/** Fresh evenly-strided keys for a rebalanced lane, in the given order. */
export const rebalancedPositions = (count: number): number[] =>
  Array.from({ length: count }, (_v, i) => (i + 1) * POSITION_GAP)
