import { describe, expect, it } from 'vitest'
import { computeLayout, treeForGrid, type Rect } from '@ui/features/layout/layout-tree'
import {
  checkResolvedSet,
  orderLiveSlots,
  selectLayoutSlots,
  ROW_BAND_PX,
  type ResolvedNow,
  type ResolvedSet
} from '@ui/features/layout/slot-selection'

// The chooser decides which panes SURVIVE a layout change: rebuild republishes the slot
// set, and the terminal feature kills the PTY of every id missing from it. So these are
// not ordering preferences — each one is a running agent that does or does not die.

const at = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })
const rects = (entries: Array<[number, Rect]>): Map<number, Rect> => new Map(entries)
const free = (): boolean => true

describe('a live slot is never traded for a free one', () => {
  it('does not take the hole while a live slot waits', () => {
    // Close pane 3 of 5 and neither removeLeaf nor serializeTree renumbers, so the gap is
    // real and outlives a restart. The old walk took slot 3 and dropped live slot 5.
    const locals = selectLayoutSlots({ count: 4, liveLocals: [1, 2, 4, 5], isFree: free, limit: 16 })
    expect(new Set(locals)).toEqual(new Set([1, 2, 4, 5]))
    expect(locals).not.toContain(3)
  })

  it('fills the hole only when the count GROWS', () => {
    const locals = selectLayoutSlots({ count: 5, liveLocals: [1, 2, 4, 5], isFree: free, limit: 16 })
    expect(new Set(locals)).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(locals.at(-1)).toBe(3) // the fill lands after every live slot
  })

  it('still refuses an id another workspace holds', () => {
    const locals = selectLayoutSlots({ count: 3, liveLocals: [1], isFree: (l) => l !== 2, limit: 16 })
    expect(locals).toEqual([1, 3, 4])
  })

  it('never duplicates a live slot whose FORMULA id is free (a moved-in pane)', () => {
    const locals = selectLayoutSlots({ count: 3, liveLocals: [3], isFree: free, limit: 16 })
    expect(locals[0]).toBe(3)
    expect(new Set(locals).size).toBe(3)
  })
})

describe('live slots are ordered by where they ARE, not by their number', () => {
  it('reads the screen, not the numbering', () => {
    // splitLine inserts beside its target, so slot 3 can sit top-left.
    const locals = selectLayoutSlots({
      count: 3,
      liveLocals: [3, 1, 2],
      rects: rects([
        [3, at(0, 0)],
        [1, at(200, 0)],
        [2, at(0, 200)]
      ]),
      isFree: free,
      limit: 16
    })
    expect(locals).toEqual([3, 1, 2])
  })

  it('a 1px difference does not reorder a row', () => {
    const locals = orderLiveSlots(
      [1, 2],
      rects([
        [1, at(300, 0)],
        [2, at(100, 1)]
      ])
    )
    expect(locals).toEqual([2, 1]) // the LEFT one first — same row
  })

  it('a staircase does not chain itself into one band', () => {
    // Each band is anchored on its own first top: 0 and 20 share a band, 40 opens the
    // next (40 - 0 > 24), 60 joins it. Anchoring on the PREVIOUS pane would make all four
    // one band and sort a whole column left to right.
    const locals = orderLiveSlots(
      [1, 2, 3, 4],
      rects([
        [1, at(300, 0)],
        [2, at(200, 20)],
        [3, at(100, 40)],
        [4, at(0, 60)]
      ])
    )
    expect(locals).toEqual([2, 1, 4, 3])
  })

  it('a real row step is never merged into the band above', () => {
    const locals = orderLiveSlots(
      [1, 2],
      rects([
        [1, at(300, 0)],
        [2, at(0, 110)] // MIN_PANE_HEIGHT_PX below — a genuine second row
      ])
    )
    expect(locals).toEqual([1, 2])
    expect(110).toBeGreaterThan(ROW_BAND_PX)
  })

  it('is scale invariant — a resolved set does not go stale because the window moved', () => {
    // A ResizeObserver can fire while a confirm dialog is up. The set is resolved once and
    // spent (see checkResolvedSet below), so this no longer decides WHICH pane dies — but
    // a rescale that reordered panes would still make the resolution describe a layout the
    // user is no longer looking at. Proportional rescaling must not reorder anyone.
    for (const tree of [treeForGrid([1, 2, 3, 4, 5, 6], 3), treeForGrid([4, 1, 7, 2], 2)]) {
      const orders = [0.5, 1, 2, 4].map((k) => {
        const computed = computeLayout(tree, { x: 0, y: 0, w: 1200 * k, h: 800 * k }, 4)
        return orderLiveSlots([...computed.leaves.keys()], computed.leaves).join(',')
      })
      expect(new Set(orders).size, `orders seen: ${orders.join(' | ')}`).toBe(1)
    }
  })
})

describe('missing geometry degrades as a whole, never partially', () => {
  const live = [3, 1, 2]
  it('no rects at all', () => {
    expect(orderLiveSlots(live)).toEqual([1, 2, 3])
    expect(orderLiveSlots(live, null)).toEqual([1, 2, 3])
  })
  it('an empty map (before the first reflow)', () => {
    expect(orderLiveSlots(live, new Map())).toEqual([1, 2, 3])
  })
  it('one live local missing its rect', () => {
    expect(
      orderLiveSlots(
        live,
        rects([
          [3, at(0, 0)],
          [1, at(200, 0)]
        ])
      )
    ).toEqual([1, 2, 3])
  })
  it('a non-finite coordinate', () => {
    expect(
      orderLiveSlots(
        live,
        rects([
          [3, at(Number.NaN, 0)],
          [1, at(200, 0)],
          [2, at(0, 200)]
        ])
      )
    ).toEqual([1, 2, 3])
  })
})

describe('the cap bounds growth, never the panes that already exist', () => {
  it('does not evict when limit() has fallen below the live count', () => {
    // limit() charges panes in OTHER workspaces against this one, so it can drop below
    // the grid the user is looking at. Rearranging what exists allocates nothing.
    const locals = selectLayoutSlots({ count: 5, liveLocals: [1, 2, 3, 4, 5], isFree: free, limit: 4 })
    expect(locals).toHaveLength(5)
  })

  it('still refuses to grow past the cap', () => {
    const locals = selectLayoutSlots({ count: 9, liveLocals: [1, 2], isFree: free, limit: 4 })
    expect(locals).toHaveLength(4)
  })
})

describe('a shrink closes from the bottom-right, in reading order', () => {
  it('keeps what you read first', () => {
    const locals = selectLayoutSlots({
      count: 2,
      liveLocals: [1, 2, 3, 4],
      rects: rects([
        [4, at(0, 0)],
        [3, at(200, 0)],
        [2, at(0, 200)],
        [1, at(200, 200)]
      ]),
      isFree: free,
      limit: 16
    })
    expect(locals).toEqual([4, 3])
  })
})

describe('a resolved set refuses when the workspace moved under it', () => {
  // The set is minted before a confirm dialog and spent after it. Everything the rule
  // reads can change during that yield, so the set carries the whole picture and is
  // re-checked at spend time — a set that no longer holds is REFUSED, never silently
  // swapped for a different one the dialog never named.
  const now = (over: Partial<ResolvedNow> = {}): ResolvedNow => ({
    source: 'ws-a',
    liveLocals: [1, 2],
    globalOf: (l) => l,
    isFree: () => true,
    ...over
  })
  // Keep slot 1, close slot 2, grow into slot 3.
  const set = (over: Partial<ResolvedSet> = {}): ResolvedSet => ({
    slots: [
      { local: 1, paneId: 1, live: true },
      { local: 3, paneId: 3, live: false }
    ],
    liveAtResolve: [1, 2],
    closing: [2],
    source: 'ws-a',
    ...over
  })

  it('holds when nothing moved', () => {
    expect(checkResolvedSet(set(), now())).toBeNull()
  })

  it('holds while the doomed pane is still alive — the dialog said it WOULD close', () => {
    expect(checkResolvedSet(set(), now({ liveLocals: [2, 1] }))).toBeNull()
  })

  it('refuses when a pane CLOSED', () => {
    expect(checkResolvedSet(set(), now({ liveLocals: [1] }))).toBe('live-set-moved')
  })

  it('refuses when a pane OPENED — it is in neither the keeps nor the doomed list', () => {
    // The case a plain "are my slots still there?" check misses entirely: nothing the set
    // names has moved, but a terminal nobody was warned about would be closed.
    expect(checkResolvedSet(set(), now({ liveLocals: [1, 2, 4] }))).toBe('live-set-moved')
  })

  it('refuses a to-grow slot whose id another workspace now holds', () => {
    expect(checkResolvedSet(set(), now({ isFree: (l) => l !== 3 }))).toBe('id-taken')
  })

  it('refuses a to-grow slot that now hosts a pane', () => {
    expect(checkResolvedSet(set(), now({ liveLocals: [1, 2, 3] }))).toBe('live-set-moved')
  })

  it('refuses a set minted by another workspace', () => {
    // The active workspace can change under a confirm: a control-API `open`, or a
    // soft-close grace lapsing. Neither is blocked by the modal's inert trap.
    expect(checkResolvedSet(set(), now({ source: 'ws-b' }))).toBe('foreign')
  })

  it('refuses a keep whose slot re-homed to a different pane', () => {
    expect(checkResolvedSet(set(), now({ globalOf: (l) => (l === 1 ? 99 : l) }))).toBe('re-homed')
  })
})

describe('degenerate input', () => {
  it('never asks for fewer than one slot', () => {
    for (const count of [0, -3, Number.NaN]) {
      expect(selectLayoutSlots({ count, liveLocals: [1, 2], isFree: free, limit: 16 })).toEqual([1])
    }
  })

  it('returns a SHORT list when the id space is exhausted, so the caller can refuse', () => {
    const locals = selectLayoutSlots({ count: 4, liveLocals: [1], isFree: () => false, limit: 16 })
    expect(locals).toEqual([1])
  })

  it('respects maxLeaves', () => {
    const locals = selectLayoutSlots({ count: 8, liveLocals: [], isFree: free, limit: 16, maxLeaves: 3 })
    expect(locals).toEqual([1, 2, 3])
  })
})
