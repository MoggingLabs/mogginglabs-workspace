import { normalize, type LayoutTreeNode } from './layout-tree'

/**
 * Region model for the wizard's dynamic layout painter (the "merged cells" grid).
 *
 * A layout is a ROWS×COLS lattice tiled exactly by rectangular REGIONS (each ≥1×1).
 * A plain grid is rows*cols 1×1 regions; merging replaces a rectangle of regions
 * with one spanning region. Every helper here is pure — the painter renders the
 * spec, and `treeForRegions` converts it into the split tree the layout engine
 * already renders, resizes, persists and restores (layout-tree.ts).
 *
 * The one real constraint lives in that conversion: a split tree is a GUILLOTINE
 * (slicing) partition — every level is one straight cut across the whole rectangle.
 * Almost every layout a human asks for (full-width row above two columns, a tall
 * left rail, …) slices; the classic counter-example is the 5-region pinwheel.
 * `mergeRegions` refuses a merge whose result would not slice, so the painter can
 * never show a layout the engine cannot build.
 */

export interface GridRegion {
  /** Top-left lattice cell (0-based) + span in cells. */
  r: number
  c: number
  rs: number
  cs: number
}

export interface GridSpecModel {
  rows: number
  cols: number
  /** Always kept in reading order (top-left first) — slot k maps to regions[k-1]. */
  regions: GridRegion[]
}

/** Reading order: top row first, then left to right. */
export function sortRegions(regions: readonly GridRegion[]): GridRegion[] {
  return [...regions].sort((a, b) => a.r - b.r || a.c - b.c)
}

/** A plain rows×cols grid — one 1×1 region per cell, reading order. */
export function uniformSpec(rows: number, cols: number): GridSpecModel {
  const regions: GridRegion[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) regions.push({ r, c, rs: 1, cs: 1 })
  return { rows, cols, regions }
}

/** The regions tile the lattice exactly: in bounds, no overlap, no gap. */
export function validateSpec(spec: GridSpecModel): boolean {
  const { rows, cols, regions } = spec
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) return false
  const covered = new Set<number>()
  for (const region of regions) {
    const { r, c, rs, cs } = region
    if (![r, c, rs, cs].every(Number.isInteger) || r < 0 || c < 0 || rs < 1 || cs < 1) return false
    if (r + rs > rows || c + cs > cols) return false
    for (let y = r; y < r + rs; y++) {
      for (let x = c; x < c + cs; x++) {
        const key = y * cols + x
        if (covered.has(key)) return false
        covered.add(key)
      }
    }
  }
  return covered.size === rows * cols
}

/** Expand a cell rectangle until it covers whole regions only (the Excel rule:
 *  a selection that clips a merged cell grows to include all of it). Bounds are
 *  inclusive cell coordinates. Always terminates: the rect only ever grows. */
export function expandToWholeRegions(
  spec: GridSpecModel,
  rect: { r0: number; c0: number; r1: number; c1: number }
): { r0: number; c0: number; r1: number; c1: number } {
  let { r0, c0, r1, c1 } = {
    r0: Math.max(0, Math.min(rect.r0, rect.r1)),
    c0: Math.max(0, Math.min(rect.c0, rect.c1)),
    r1: Math.min(spec.rows - 1, Math.max(rect.r0, rect.r1)),
    c1: Math.min(spec.cols - 1, Math.max(rect.c0, rect.c1))
  }
  for (;;) {
    let grew = false
    for (const region of spec.regions) {
      const rr1 = region.r + region.rs - 1
      const rc1 = region.c + region.cs - 1
      const overlaps = region.r <= r1 && rr1 >= r0 && region.c <= c1 && rc1 >= c0
      if (!overlaps) continue
      if (region.r < r0) {
        r0 = region.r
        grew = true
      }
      if (region.c < c0) {
        c0 = region.c
        grew = true
      }
      if (rr1 > r1) {
        r1 = rr1
        grew = true
      }
      if (rc1 > c1) {
        c1 = rc1
        grew = true
      }
    }
    if (!grew) return { r0, c0, r1, c1 }
  }
}

/** Merge every region inside the (expanded) rect into one spanning region.
 *  Null when the merge is a no-op (a single region) or the result would not
 *  slice into a split tree — the caller keeps the current spec and says why. */
export function mergeRegions(
  spec: GridSpecModel,
  rect: { r0: number; c0: number; r1: number; c1: number }
): GridSpecModel | null {
  const box = expandToWholeRegions(spec, rect)
  const inside = (region: GridRegion): boolean =>
    region.r >= box.r0 && region.c >= box.c0 && region.r + region.rs - 1 <= box.r1 && region.c + region.cs - 1 <= box.c1
  const kept = spec.regions.filter((region) => !inside(region))
  if (kept.length === spec.regions.length - 1 || kept.length === spec.regions.length) return null
  const merged: GridRegion = { r: box.r0, c: box.c0, rs: box.r1 - box.r0 + 1, cs: box.c1 - box.c0 + 1 }
  const next: GridSpecModel = { rows: spec.rows, cols: spec.cols, regions: sortRegions([...kept, merged]) }
  if (!validateSpec(next) || !treeForRegions(next)) return null
  return next
}

/** Split one merged region back into its 1×1 cells. */
export function unmergeRegion(spec: GridSpecModel, index: number): GridSpecModel {
  const region = spec.regions[index]
  if (!region || (region.rs === 1 && region.cs === 1)) return spec
  const cells: GridRegion[] = []
  for (let y = region.r; y < region.r + region.rs; y++) {
    for (let x = region.c; x < region.c + region.cs; x++) cells.push({ r: y, c: x, rs: 1, cs: 1 })
  }
  return {
    rows: spec.rows,
    cols: spec.cols,
    regions: sortRegions([...spec.regions.filter((_, i) => i !== index), ...cells])
  }
}

/** A spec for EXACTLY `n` panes: fill full rows on the near-square lattice, and
 *  when the last row comes up short its final pane spans the remaining columns —
 *  the region twin of treeForGrid's ragged last row. Prefill/recents may name any
 *  1..16 count; the painter then shows something true, not a rounded-up grid. */
export function specForCount(n: number, shape?: { rows: number; cols: number }): GridSpecModel {
  const count = Math.max(1, Math.floor(n))
  const cols = shape?.cols ?? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))))
  const rows = shape?.rows ?? Math.ceil(count / cols)
  const regions: GridRegion[] = []
  let left = count
  for (let r = 0; r < rows && left > 0; r++) {
    const inRow = Math.min(cols, left)
    for (let c = 0; c < inRow; c++) {
      const last = c === inRow - 1
      regions.push({ r, c, rs: 1, cs: last ? cols - c : 1 })
    }
    left -= inRow
  }
  const spec: GridSpecModel = { rows, cols, regions: sortRegions(regions) }
  return validateSpec(spec) ? spec : uniformSpec(1, 1)
}

/**
 * Convert regions → the split tree the layout engine renders. Leaf ids are the
 * regions' READING-ORDER slots (1-based): region k is pane slot k+1, which is what
 * keeps every slot-indexed manifest array (assignments/cwds/roles/profiles) aligned.
 * Null when the partition is not a guillotine layout (no straight full cut exists).
 */
export function treeForRegions(spec: GridSpecModel): LayoutTreeNode | null {
  if (!validateSpec(spec)) return null
  const ordered = sortRegions(spec.regions)
  const slotOf = new Map<GridRegion, number>()
  ordered.forEach((region, i) => slotOf.set(region, i + 1))

  const slice = (regions: GridRegion[], r0: number, c0: number, r1: number, c1: number): LayoutTreeNode | null => {
    if (regions.length === 1) return { id: slotOf.get(regions[0]!)! }
    // Full horizontal cuts: a row line y (r0 < y < r1, exclusive bounds) no region crosses.
    const hCuts: number[] = []
    for (let y = r0 + 1; y < r1; y++) {
      if (regions.every((region) => region.r >= y || region.r + region.rs <= y)) hCuts.push(y)
    }
    if (hCuts.length) {
      const bounds = [r0, ...hCuts, r1]
      const children: LayoutTreeNode[] = []
      const sizes: number[] = []
      for (let i = 0; i < bounds.length - 1; i++) {
        const [top, bottom] = [bounds[i]!, bounds[i + 1]!]
        const segment = regions.filter((region) => region.r >= top && region.r + region.rs <= bottom)
        const child = slice(segment, top, c0, bottom, c1)
        if (!child) return null
        children.push(child)
        sizes.push((bottom - top) / (r1 - r0))
      }
      return { dir: 'v', children, sizes }
    }
    const vCuts: number[] = []
    for (let x = c0 + 1; x < c1; x++) {
      if (regions.every((region) => region.c >= x || region.c + region.cs <= x)) vCuts.push(x)
    }
    if (vCuts.length) {
      const bounds = [c0, ...vCuts, c1]
      const children: LayoutTreeNode[] = []
      const sizes: number[] = []
      for (let i = 0; i < bounds.length - 1; i++) {
        const [left, right] = [bounds[i]!, bounds[i + 1]!]
        const segment = regions.filter((region) => region.c >= left && region.c + region.cs <= right)
        const child = slice(segment, r0, left, r1, right)
        if (!child) return null
        children.push(child)
        sizes.push((right - left) / (c1 - c0))
      }
      return { dir: 'h', children, sizes }
    }
    return null // no straight cut — a non-guillotine partition (pinwheel-shaped)
  }

  const root = slice(ordered, 0, 0, spec.rows, spec.cols)
  return root ? normalize(root) : null
}
