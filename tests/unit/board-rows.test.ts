import { describe, expect, it } from 'vitest'
import {
  appendPosition,
  boardRowToBoard,
  cardRowToCard,
  insertPosition,
  POSITION_GAP,
  rebalancedPositions,
  sanitizeBoardConfig,
  sanitizeLabels,
  sanitizeLane,
  sanitizePriority,
  type BoardCardRowCells
} from '@backend/features/workspace/board-rows'

// The pure half of Board v2: the position math that keeps within-lane ordering
// stable under repeated inserts, and the sanitizers that keep a corrupt or
// hostile cell from ever throwing out of a read or smuggling NaN into a
// budget. Every clamp here guards a runtime promise (the queue's budgets, the
// WIP limits, the CAS row shape) — a loosened clamp fails HERE, not in a
// user's unattended queue run.

describe('position math', () => {
  it('appends with a full gap, from empty and from a tail', () => {
    expect(appendPosition(undefined)).toBe(POSITION_GAP)
    expect(appendPosition(4096)).toBe(4096 + POSITION_GAP)
  })

  it('inserts at the midpoint between neighbours', () => {
    const placed = insertPosition(1024, 2048)
    expect(placed.rebalance).toBe(false)
    expect(placed.position).toBeGreaterThan(1024)
    expect(placed.position).toBeLessThan(2048)
  })

  it('inserts before the head using a synthetic floor', () => {
    const placed = insertPosition(undefined, 1024)
    expect(placed.rebalance).toBe(false)
    expect(placed.position).toBeLessThan(1024)
  })

  it('demands a rebalance once the midpoint stops being trustworthy', () => {
    // Repeated same-spot inserts exhaust the float: simulate the pathological
    // neighbourhood directly.
    const placed = insertPosition(1024, 1024 + 1e-9)
    expect(placed.rebalance).toBe(true)
  })

  it('rebalances to even strides, order preserved by construction', () => {
    expect(rebalancedPositions(3)).toEqual([POSITION_GAP, 2 * POSITION_GAP, 3 * POSITION_GAP])
    expect(rebalancedPositions(0)).toEqual([])
  })
})

describe('sanitizers', () => {
  it('lanes and priorities are closed unions — junk answers undefined', () => {
    expect(sanitizeLane('doing')).toBe('doing')
    expect(sanitizeLane('backlog')).toBe('backlog')
    expect(sanitizeLane('shipping')).toBeUndefined()
    expect(sanitizeLane(7)).toBeUndefined()
    expect(sanitizePriority('urgent')).toBe('urgent')
    expect(sanitizePriority('asap')).toBeUndefined()
  })

  it('labels: trimmed, deduped, capped in count and length, never a throw', () => {
    expect(sanitizeLabels(['  perf ', 'perf', '', 42, 'x'.repeat(99)])).toEqual(['perf', 'x'.repeat(24)])
    expect(sanitizeLabels('not-an-array')).toEqual([])
    expect(sanitizeLabels([...Array(20).keys()].map((i) => `l${i}`))).toHaveLength(8)
  })
})

describe('board config sanitization (the queue budgets live here)', () => {
  it('a corrupt cell degrades to defaults', () => {
    const config = sanitizeBoardConfig('garbage')
    expect(config.queue.enabled).toBe(false)
    expect(config.agingDays).toBeGreaterThan(0)
  })

  it('the queue can NEVER deserialize into an unbounded budget', () => {
    const config = sanitizeBoardConfig({
      queue: { enabled: true, maxConcurrent: 999, launchesPerHour: -3, provider: 'x'.repeat(200), launches: ['a', 12, NaN] }
    })
    expect(config.queue.maxConcurrent).toBeLessThanOrEqual(4)
    expect(config.queue.launchesPerHour).toBeGreaterThanOrEqual(1)
    expect(config.queue.launchesPerHour).toBeLessThanOrEqual(20)
    expect(config.queue.provider).toHaveLength(64)
    expect(config.queue.launches).toEqual([12])
  })

  it('enabled/writeBack/rules are strict-true booleans — "yes" is off', () => {
    const config = sanitizeBoardConfig({
      queue: { enabled: 'yes' },
      github: { writeBack: 1 },
      rules: { prMergedToDone: 'true' }
    })
    expect(config.queue.enabled).toBe(false)
    expect(config.github.writeBack).toBe(false)
    expect(config.rules.prMergedToDone).toBe(false)
  })

  it('WIP limits clamp to 0..99 and drop the zeros', () => {
    const config = sanitizeBoardConfig({ wip: { todo: 500, doing: -2, review: 3, done: 'x' } })
    expect(config.wip).toEqual({ todo: 99, review: 3 })
  })
})

describe('row mapping', () => {
  const row: BoardCardRowCells = {
    id: 'c1',
    boardId: 'b1',
    title: 'T',
    notes: 'N',
    lane: 'review',
    position: 2048,
    revision: 5,
    priority: 'high',
    labels: '["a","b"]',
    blocked: 1,
    blockedReason: 'why',
    dueAt: 123,
    archivedAt: null,
    paneId: 101,
    workspaceId: 'ws',
    branch: 'mogging/ab12',
    createdAt: 1,
    updatedAt: 2
  }

  it('round-trips every field a lane render depends on', () => {
    const card = cardRowToCard(row)
    expect(card).toMatchObject({
      id: 'c1',
      boardId: 'b1',
      lane: 'review',
      position: 2048,
      revision: 5,
      priority: 'high',
      labels: ['a', 'b'],
      blocked: true,
      blockedReason: 'why',
      paneId: 101,
      branch: 'mogging/ab12'
    })
  })

  it('degrades corrupt cells field-by-field, never row-by-row', () => {
    const card = cardRowToCard({ ...row, lane: 'junk', labels: '{broken', priority: null, revision: NaN })
    expect(card.lane).toBe('todo')
    expect(card.labels).toEqual([])
    expect(card.priority).toBe('normal')
    expect(card.revision).toBe(0)
  })

  it('board rows carry a sanitized config, defaults when the cell is corrupt', () => {
    const board = boardRowToBoard({
      id: 'b1',
      name: 'Alpha',
      projectKey: 'C:\\repos\\alpha',
      repoRef: 'acme/web',
      config: '{"queue":{"enabled":true,"maxConcurrent":99}}',
      createdAt: 1,
      updatedAt: 2
    })
    expect(board.repoRef).toBe('acme/web')
    expect(board.config.queue.enabled).toBe(true)
    expect(board.config.queue.maxConcurrent).toBe(4)
    const corrupt = boardRowToBoard({ id: 'b2', name: 'B', projectKey: 'k', repoRef: null, config: '{oops', createdAt: 1, updatedAt: 2 })
    expect(corrupt.config.queue.enabled).toBe(false)
  })
})
