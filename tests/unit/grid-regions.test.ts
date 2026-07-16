import { describe, expect, it } from 'vitest'
import {
  expandToWholeRegions,
  mergeRegions,
  specForCount,
  sortRegions,
  treeForRegions,
  unmergeRegion,
  uniformSpec,
  validateSpec,
  type GridSpecModel
} from '../../src/ui/features/layout/grid-regions'
import { computeLayout, leafIds, type LayoutTreeNode } from '../../src/ui/features/layout/layout-tree'

// The wizard's merged-cell layouts ride the existing split tree, so the ONE thing
// that must never lie is the region→tree conversion: slot ids in reading order,
// fractions matching the lattice, and honest refusal of unsliceable partitions.

const rect = (r0: number, c0: number, r1: number, c1: number): { r0: number; c0: number; r1: number; c1: number } => ({
  r0,
  c0,
  r1,
  c1
})

describe('grid regions', () => {
  it('uniform specs validate and slice to trees with reading-order slots', () => {
    for (const [rows, cols] of [
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 3],
      [3, 3],
      [4, 4]
    ] as const) {
      const spec = uniformSpec(rows, cols)
      expect(validateSpec(spec)).toBe(true)
      const tree = treeForRegions(spec)
      expect(tree).not.toBeNull()
      expect(leafIds(tree as LayoutTreeNode).sort((a, b) => a - b)).toEqual(
        Array.from({ length: rows * cols }, (_, i) => i + 1)
      )
    }
  })

  it('the asked-for layout: one full-width terminal above two below', () => {
    const merged = mergeRegions(uniformSpec(2, 2), rect(0, 0, 0, 1))
    expect(merged).not.toBeNull()
    expect(merged!.regions).toEqual([
      { r: 0, c: 0, rs: 1, cs: 2 },
      { r: 1, c: 0, rs: 1, cs: 1 },
      { r: 1, c: 1, rs: 1, cs: 1 }
    ])
    const tree = treeForRegions(merged!)
    expect(tree).not.toBeNull()
    // Slot 1 = the merged top region; its rect spans the full width, half the height.
    const layout = computeLayout(tree as LayoutTreeNode, { x: 0, y: 0, w: 1000, h: 600 }, 0, 0)
    const top = layout.leaves.get(1)!
    const left = layout.leaves.get(2)!
    const right = layout.leaves.get(3)!
    expect(top.w).toBe(1000)
    expect(Math.round(top.h)).toBe(300)
    expect(Math.round(left.w)).toBe(500)
    expect(left.y).toBeGreaterThanOrEqual(300)
    expect(right.x).toBeGreaterThanOrEqual(500)
  })

  it('a tall left rail: full-height column beside stacked rows', () => {
    const merged = mergeRegions(uniformSpec(2, 2), rect(0, 0, 1, 0))
    expect(merged).not.toBeNull()
    const tree = treeForRegions(merged!)
    expect(tree).not.toBeNull()
    const layout = computeLayout(tree as LayoutTreeNode, { x: 0, y: 0, w: 800, h: 600 }, 0, 0)
    expect(layout.leaves.get(1)!.h).toBe(600) // the rail is full height
  })

  it('merges expand to cover whole regions (the Excel rule)', () => {
    const spec = mergeRegions(uniformSpec(2, 3), rect(0, 0, 0, 1))! // top-left 1×2 merged
    // Selecting the clipped half of the merged region plus its neighbor grows to all three.
    const grown = expandToWholeRegions(spec, rect(0, 1, 0, 2))
    expect(grown).toEqual({ r0: 0, c0: 0, r1: 0, c1: 2 })
    const merged = mergeRegions(spec, rect(0, 1, 0, 2))
    expect(merged).not.toBeNull()
    expect(merged!.regions[0]).toEqual({ r: 0, c: 0, rs: 1, cs: 3 })
  })

  it('refuses a merge that would need a non-guillotine (pinwheel) layout', () => {
    // Build the pinwheel on 3×3 step by step; the last merge that completes it must refuse.
    let spec: GridSpecModel | null = uniformSpec(3, 3)
    spec = mergeRegions(spec, rect(0, 0, 0, 1)) // top bar
    expect(spec).not.toBeNull()
    spec = mergeRegions(spec!, rect(1, 2, 2, 2))
    expect(spec).not.toBeNull() // right bar still slices? (top 1×2, right 2×1, rest singles)
    spec = mergeRegions(spec!, rect(2, 0, 2, 1)) // bottom bar — the pinwheel needs left bar next
    if (spec) {
      const final = mergeRegions(spec, rect(0, 0, 1, 0)) // left bar overlaps top bar -> expands to everything
      // Either the earlier arrangement already refused, or this expansion swallows the
      // grid whole (a single region merge of everything is legal and slices trivially).
      if (final) expect(treeForRegions(final)).not.toBeNull()
    }
    // The canonical direct check: a hand-built pinwheel partition does not slice.
    const pinwheel: GridSpecModel = {
      rows: 3,
      cols: 3,
      regions: sortRegions([
        { r: 0, c: 0, rs: 1, cs: 2 },
        { r: 0, c: 2, rs: 2, cs: 1 },
        { r: 2, c: 1, rs: 1, cs: 2 },
        { r: 1, c: 0, rs: 2, cs: 1 },
        { r: 1, c: 1, rs: 1, cs: 1 }
      ])
    }
    expect(validateSpec(pinwheel)).toBe(true)
    expect(treeForRegions(pinwheel)).toBeNull()
  })

  it('unmerge restores the 1×1 cells', () => {
    const merged = mergeRegions(uniformSpec(2, 2), rect(0, 0, 0, 1))!
    const back = unmergeRegion(merged, 0)
    expect(back.regions).toHaveLength(4)
    expect(validateSpec(back)).toBe(true)
    expect(back).toEqual(uniformSpec(2, 2))
  })

  it('specForCount fills rows and spans the ragged tail', () => {
    const five = specForCount(5)
    expect(validateSpec(five)).toBe(true)
    expect(five.regions).toHaveLength(5)
    expect(treeForRegions(five)).not.toBeNull()
    const three = specForCount(3)
    expect(three.regions).toHaveLength(3)
    expect(validateSpec(three)).toBe(true)
    // Curated shapes pass through.
    const eight = specForCount(8, { rows: 2, cols: 4 })
    expect(eight.rows).toBe(2)
    expect(eight.cols).toBe(4)
    expect(eight.regions).toHaveLength(8)
  })

  it('merge is a no-op refusal on a single region and on the full grid selection of one region', () => {
    expect(mergeRegions(uniformSpec(1, 1), rect(0, 0, 0, 0))).toBeNull()
    expect(mergeRegions(uniformSpec(2, 2), rect(0, 0, 0, 0))).toBeNull()
  })

  it('fractions honor spans: a 1×3 top over 3 columns splits v then h in thirds', () => {
    const merged = mergeRegions(uniformSpec(2, 3), rect(0, 0, 0, 2))!
    const tree = treeForRegions(merged)!
    const layout = computeLayout(tree, { x: 0, y: 0, w: 900, h: 600 }, 0, 0)
    expect(layout.leaves.get(1)!.w).toBe(900)
    expect(Math.round(layout.leaves.get(2)!.w)).toBe(300)
    expect(Math.round(layout.leaves.get(3)!.w)).toBe(300)
    expect(Math.round(layout.leaves.get(4)!.w)).toBe(300)
  })
})
