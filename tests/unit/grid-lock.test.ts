import { describe, expect, it } from 'vitest'
import { mergeRegions, mergeRespectsLock, uniformSpec, unmergeRegion } from '@ui/features/layout/grid-regions'

// The New-terminals painter marks the terminals that ALREADY EXIST as a locked PREFIX —
// a count, not a set of indices. That is only sound if the region operations preserve the
// prefix, so the property is proven here rather than argued in a comment: get it wrong and
// a locked tile silently becomes a different pane than the one drawn on it.

const prefix = (spec: { regions: unknown[] }, n: number): string => JSON.stringify(spec.regions.slice(0, n))

describe('merging preserves the locked prefix', () => {
  it('every merge that spares the locked regions leaves them exactly where they were', () => {
    for (const [rows, cols] of [
      [2, 2],
      [2, 3],
      [3, 3],
      [4, 4]
    ] as const) {
      const spec = uniformSpec(rows, cols)
      for (let locked = 0; locked <= spec.regions.length; locked++) {
        const before = prefix(spec, locked)
        for (let r0 = 0; r0 < rows; r0++)
          for (let c0 = 0; c0 < cols; c0++)
            for (let r1 = r0; r1 < rows; r1++)
              for (let c1 = c0; c1 < cols; c1++) {
                const rect = { r0, c0, r1, c1 }
                if (!mergeRespectsLock(spec, rect, locked)) continue
                const merged = mergeRegions(spec, rect)
                if (!merged) continue
                expect(prefix(merged, locked), `${rows}x${cols} locked=${locked} rect=${JSON.stringify(rect)}`).toBe(
                  before
                )
              }
      }
    }
  })

  it('is not vacuous — merges that spare the prefix genuinely exist', () => {
    const spec = uniformSpec(2, 3)
    // Lock the top row (3 regions); the bottom row still merges.
    expect(mergeRespectsLock(spec, { r0: 1, c0: 0, r1: 1, c1: 2 }, 3)).toBe(true)
    expect(mergeRegions(spec, { r0: 1, c0: 0, r1: 1, c1: 2 })).not.toBeNull()
  })
})

describe('a merge that would swallow an existing terminal is refused', () => {
  const spec = uniformSpec(2, 2)

  it('refuses a box over a locked tile', () => {
    expect(mergeRespectsLock(spec, { r0: 0, c0: 0, r1: 1, c1: 1 }, 1)).toBe(false)
    expect(mergeRespectsLock(spec, { r0: 0, c0: 0, r1: 0, c1: 1 }, 1)).toBe(false)
  })

  it('allows a box that clears them', () => {
    expect(mergeRespectsLock(spec, { r0: 1, c0: 0, r1: 1, c1: 1 }, 2)).toBe(true)
  })

  it('refuses via the EXPANDED box, not the raw drag', () => {
    // Merge the bottom row, then lock 3 regions: [top-left, top-right, bottom-span]. A drag
    // over the bottom-left cell alone expands to the whole spanning region — which is
    // locked — so the raw rect looking clear must not be enough.
    const withSpan = mergeRegions(spec, { r0: 1, c0: 0, r1: 1, c1: 1 })!
    expect(withSpan.regions).toHaveLength(3)
    expect(mergeRespectsLock(withSpan, { r0: 1, c0: 0, r1: 1, c1: 0 }, 3)).toBe(false)
  })

  it('is a no-op when nothing is locked', () => {
    expect(mergeRespectsLock(spec, { r0: 0, c0: 0, r1: 1, c1: 1 }, 0)).toBe(true)
  })
})

describe('unmerging preserves the prefix too', () => {
  it('splitting a region after the prefix leaves it untouched', () => {
    const spec = mergeRegions(uniformSpec(2, 2), { r0: 1, c0: 0, r1: 1, c1: 1 })!
    const before = prefix(spec, 2)
    const split = unmergeRegion(spec, 2)
    expect(prefix(split, 2)).toBe(before)
    expect(split.regions).toHaveLength(4)
  })
})
