import { describe, expect, it } from 'vitest'
import { leafIds, normalize, removeLeaf, splitLine, swapLeaves, treeForGrid } from '@ui/features/layout/layout-tree'

// THE PANE TREE.
//
// Every PTY-preserving rearrange goes through these: split a line, remove a leaf, swap two,
// then normalize. A regression here does not crash — it silently loses a pane's geometry or,
// worse, its id, and the pane's shell goes with it.
//
// The module has ZERO imports, so it is directly testable; it simply never was.

const ids = (t: ReturnType<typeof treeForGrid>): number[] => [...leafIds(t)].sort((a, b) => a - b)

describe('treeForGrid', () => {
  it('holds exactly the ids it was given', () => {
    expect(ids(treeForGrid([1, 2, 3, 4], 2))).toEqual([1, 2, 3, 4])
    expect(ids(treeForGrid([7], 1))).toEqual([7])
  })
})

describe('splitLine', () => {
  it('adds the new leaf and keeps every existing one', () => {
    const t = splitLine(treeForGrid([1, 2, 3, 4], 2), 2, 5, 'v')
    expect(ids(t)).toEqual([1, 2, 3, 4, 5])
  })

  it('re-equalizes the line it split — sizes sum to 1', () => {
    const t = splitLine(treeForGrid([1, 2], 2), 1, 3, 'h')
    // Floating point: a line summing to 1 within an epsilon is equalized; one summing to 1.5
    // is a pane drawn off the edge of its container.
    const sums: number[] = []
    const walk = (node: typeof t): void => {
      if (!('children' in node)) return
      sums.push(node.sizes.reduce((n, x) => n + x, 0))
      for (const c of node.children) walk(c)
    }
    walk(t)
    expect(sums.length, 'no split node found — the fixture is not a split').toBeGreaterThan(0)
    for (const s of sums) expect(Math.abs(s - 1)).toBeLessThan(1e-9)
  })
})

describe('removeLeaf', () => {
  it('drops exactly one id and keeps the rest', () => {
    const t = removeLeaf(treeForGrid([1, 2, 3, 4], 2), 3)
    expect(t).not.toBeNull()
    if (t) expect(ids(t)).toEqual([1, 2, 4])
  })

  it('returns null when the last leaf goes — there is no empty tree', () => {
    expect(removeLeaf(treeForGrid([1], 1), 1)).toBeNull()
  })

  it('ignores an id that is not in the tree rather than mangling it', () => {
    const t = removeLeaf(treeForGrid([1, 2], 2), 99)
    expect(t).not.toBeNull()
    if (t) expect(ids(t)).toEqual([1, 2])
  })
})

describe('swapLeaves', () => {
  // It mutates in place and returns void — the pane ids trade positions, the geometry does not
  // move. Asserting the SET is what catches a swap that drops or duplicates an id.
  it('preserves the id SET — a swap moves panes, it does not create or destroy them', () => {
    const t = treeForGrid([1, 2, 3, 4], 2)
    swapLeaves(t, 1, 4)
    expect(ids(t)).toEqual([1, 2, 3, 4])
  })

  it('is its own inverse', () => {
    const before = JSON.stringify(treeForGrid([1, 2, 3, 4], 2))
    const t = treeForGrid([1, 2, 3, 4], 2)
    swapLeaves(t, 2, 3)
    expect(JSON.stringify(t), 'a swap must actually move something').not.toBe(before)
    swapLeaves(t, 2, 3)
    expect(JSON.stringify(t)).toBe(before)
  })

  it('ignores a swap with itself, and with an absent id', () => {
    const t = treeForGrid([1, 2], 2)
    const before = JSON.stringify(t)
    swapLeaves(t, 1, 1)
    swapLeaves(t, 1, 99)
    expect(JSON.stringify(t)).toBe(before)
  })
})

describe('normalize', () => {
  it('never changes which panes exist', () => {
    const t = splitLine(treeForGrid([1, 2, 3, 4], 2), 1, 5, 'v')
    expect(ids(normalize(t))).toEqual(ids(t))
  })

  it('is idempotent — normalizing twice is normalizing once', () => {
    const t = normalize(removeLeaf(treeForGrid([1, 2, 3, 4], 2), 2) ?? treeForGrid([1], 1))
    expect(JSON.stringify(normalize(t))).toBe(JSON.stringify(t))
  })

  it('collapses a single-child node rather than leaving a wrapper', () => {
    const shrunk = removeLeaf(treeForGrid([1, 2], 2), 2)
    expect(shrunk).not.toBeNull()
    if (shrunk) expect(normalize(shrunk)).toMatchObject({ id: 1 })
  })
})
