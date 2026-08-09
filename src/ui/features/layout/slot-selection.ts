/**
 * WHICH SLOTS a new layout lands on — the rule behind `GridLayout.templateLocals`,
 * extracted so it can be reasoned about and tested without a DOM.
 *
 * A workspace's panes live in numbered LOCAL SLOTS (1..MAX_LEAVES). Applying a template
 * or a painted grid rebuilds the tree over a chosen set of slots, and the slot set is
 * what decides which panes SURVIVE: `rebuild` republishes the slots, and the terminal
 * feature disposes — and kills the PTY of — every pane id missing from that set. So this
 * function is the difference between "rearranged my terminals" and "closed my agent".
 *
 * The rule this replaces walked 1..MAX_LEAVES accepting "live OR free" and stopped at
 * `count`, which took a FREE HOLE ahead of a live slot: close pane 3 of 5 — neither
 * `removeLeaf` nor `serializeTree` renumbers, so the gap outlives a restart — and any
 * equal-count reorganize dropped live slot 5 to grow into slot 3. The confirm dialog
 * honestly reported the kill; the choice underneath it was wrong.
 */

import { MAX_LEAVES, type Rect } from './layout-tree'

/**
 * Rows are BANDED before they are read left to right. Two panes whose tops differ by a
 * pixel are one row to a human, and rects come out of a weighted water-fill allocator as
 * floats. 24px is a fraction of MIN_PANE_HEIGHT_PX (110) — far above rounding noise, far
 * below a real row step — and `computeLayout` grows its canvas rather than crushing a leaf
 * below that floor, so a band can never swallow two genuine rows at any window size.
 */
export const ROW_BAND_PX = 24

export interface SlotSelection {
  /** Slots the new layout asks for: a template's N, a painted spec's region count. */
  count: number
  /** The slots that currently HOST a pane (`GridLayout.liveLocals()`), in any order. */
  liveLocals: readonly number[]
  /** Where those slots are on screen RIGHT NOW (`GridLayout.leafRects`). */
  rects?: ReadonlyMap<number, Rect> | null
  /**
   * May slot `local` be GROWN into? False when its pane id is live anywhere — a pane that
   * moved workspaces took its id along, and re-growing into that slot would aim two panes
   * at one daemon session — and false for a detached leaf, whose pane now lives elsewhere.
   */
  isFree: (local: number) => boolean
  /** The workspace's GROWTH ceiling (`GridLayout.limit()`). */
  limit: number
  /** Hard slot-id ceiling. Defaults to MAX_LEAVES. */
  maxLeaves?: number
}

/**
 * The slots an `apply`/`applyRegions` will land on, IN THE ORDER THE NEW LAYOUT READS
 * THEM (entry 0 = the top-left region).
 *
 * Two rules, in this order:
 *
 *  1. EVERY live slot first, capped at `count`. A live slot is a running terminal with a
 *     PTY and usually an agent inside it; a free slot is nothing at all. Never trade the
 *     first for the second.
 *  2. Live slots ordered by WHERE THEY ARE — reading order over the current rects — not
 *     by slot number. Each pane then lands in the region nearest the one it already
 *     occupies, so a reshape reads as a resize instead of a shuffle. Slot number stopped
 *     meaning position at the first split anyway: `splitLine` inserts the new leaf BESIDE
 *     its target, so a 2×2 split into 5 reads 1,5,2,3,4 across the screen.
 *
 * The remainder is filled from the LOWEST free id, which is what keeps a re-grown slot
 * from handing out an id another workspace's pane is still using.
 *
 * Fewer than `count` entries means the id space ran out: the caller refuses
 * (`applyRegions`) or builds the shorter grid (`apply`).
 */
export function selectLayoutSlots(input: SlotSelection): number[] {
  const maxLeaves = input.maxLeaves ?? MAX_LEAVES
  const live = orderLiveSlots(input.liveLocals, input.rects)
  // The ceiling governs GROWTH, never eviction. `limit()` charges the machine budget for
  // panes in OTHER workspaces, so it can fall BELOW the count this workspace already runs
  // — and clamping to it there would let a busier machine close your agents the next time
  // you rearranged. Rearranging what already exists allocates nothing, so the status quo
  // is always reachable; growth doors ask `effectiveMaxPanes` and are unaffected.
  const limit = Number.isFinite(input.limit) ? Math.floor(input.limit) : maxLeaves
  const ceiling = Math.max(1, Math.min(maxLeaves, Math.max(live.length, limit)))
  const count = Math.max(1, Math.min(ceiling, Math.floor(input.count) || 0))

  const locals = live.slice(0, count)
  // Explicit, not implied by `isFree`: a slot holding a MOVED-IN pane answers to an id
  // override, so its FORMULA id really is free — and filling it would hand out a local
  // this workspace is already rendering.
  const taken = new Set(locals)
  for (let local = 1; locals.length < count && local <= maxLeaves; local++) {
    if (!taken.has(local) && input.isFree(local)) locals.push(local)
  }
  return locals
}

/**
 * Live slots in READING order: banded rows top to bottom, left to right inside a band,
 * slot number as the final tiebreak so the order is TOTAL (never engine-dependent).
 *
 * Degrades AS A WHOLE — never partially — to ascending slot order when geometry is
 * missing or non-finite: before the first reflow (the GridLayout constructor applies its
 * opening tree with `leafRects` still empty) and in any headless path. A half-ordered
 * answer is the only genuinely confusing one; ascending is deterministic and is exactly
 * what this function's predecessor did.
 */
export function orderLiveSlots(
  liveLocals: readonly number[],
  rects?: ReadonlyMap<number, Rect> | null
): number[] {
  const ascending = [...new Set(liveLocals)].sort((a, b) => a - b)
  if (!rects || ascending.length < 2) return ascending

  const placed: Array<{ local: number; x: number; y: number }> = []
  for (const local of ascending) {
    const rect = rects.get(local)
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return ascending
    placed.push({ local, x: rect.x, y: rect.y })
  }

  // Bands form top-down, each anchored on ITS OWN first top — anchoring on the previous
  // pane's top would let a staircase of 20px steps chain itself into one band and sort a
  // whole column by x.
  placed.sort((a, b) => a.y - b.y || a.x - b.x || a.local - b.local)
  let bandTop = placed[0]!.y
  const banded = placed.map((p) => {
    if (p.y - bandTop > ROW_BAND_PX) bandTop = p.y
    return { local: p.local, x: p.x, band: bandTop }
  })
  banded.sort((a, b) => a.band - b.band || a.x - b.x || a.local - b.local)
  return banded.map((p) => p.local)
}

/**
 * A RESOLVED SET — the slots one layout change will land on, minted once and spent once.
 *
 * The rule above is pure, but its INPUTS are not: `liveLocals`, `leafRects` and `limit`
 * all move. Every destructive door reads them, names the doomed panes in a confirm
 * dialog, and then `await`s the user — an arbitrary yield during which a ResizeObserver
 * can reorder the rects, a pane can open or close, or the cap can drop because panes
 * opened in another workspace. Resolving again after that await produced a set the dialog
 * had never described, and applying it was silent.
 *
 * So the set is resolved BEFORE the yield and carried as a value. `checkResolvedSet` then
 * asks, at spend time, whether it still describes the same workspace — and a set that no
 * longer does is REFUSED rather than quietly replaced. A visible refusal is the point:
 * the alternative is closing terminals nobody was warned about.
 */
export interface ResolvedSlot {
  local: number
  paneId: number
  /** Already HOSTS a pane (a KEEP) vs. one this apply will CREATE. The two are validated
   *  differently: a keep must still be live, a create must still be free. */
  live: boolean
}

export interface ResolvedSet {
  readonly slots: readonly ResolvedSlot[]
  /**
   * Every live local the workspace held when this was minted — kept AND doomed. The check
   * demands the live set is still EXACTLY this, because the dangerous case is not a slot
   * going missing: it is a pane that OPENED. Such a pane appears in neither the keeps nor
   * the doomed list, so a set pinned without this field would close it without the dialog
   * ever having mentioned it.
   */
  readonly liveAtResolve: readonly number[]
  /** The pane ids the caller must NAME as closing — `liveAtResolve` minus the keeps. */
  readonly closing: readonly number[]
  /** The grid that minted it. A set spent on a different workspace is refused: the active
   *  workspace can change under a confirm (a control-API `open`, or a soft-close grace
   *  lapsing), and neither path is blocked by the modal's inert trap. */
  readonly source: string
}

export type ResolvedRefusal = 'foreign' | 'live-set-moved' | 'slot-taken' | 'id-taken' | 're-homed'

export interface ResolvedNow {
  source: string
  liveLocals: readonly number[]
  globalOf: (local: number) => number
  /** GridLayout's own growth predicate: not detached, and the formula id free everywhere. */
  isFree: (local: number) => boolean
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && new Set(a).size === new Set([...a, ...b]).size

/** Does this set still describe this grid? `null` = yes; otherwise WHY not. */
export function checkResolvedSet(set: ResolvedSet, now: ResolvedNow): ResolvedRefusal | null {
  if (set.source !== now.source) return 'foreign'
  if (!sameSet(set.liveAtResolve, now.liveLocals)) return 'live-set-moved'
  const live = new Set(now.liveLocals)
  for (const slot of set.slots) {
    if (slot.live) {
      // A keep whose pane is gone would have `treeForGrid` mint an empty slot in its place.
      if (!live.has(slot.local)) return 'live-set-moved'
      if (now.globalOf(slot.local) !== slot.paneId) return 're-homed'
    } else {
      // A create that filled up would hand one id to two panes.
      if (live.has(slot.local)) return 'slot-taken'
      if (!now.isFree(slot.local) || now.globalOf(slot.local) !== slot.paneId) return 'id-taken'
    }
  }
  return null
}
