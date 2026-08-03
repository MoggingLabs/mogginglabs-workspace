import { describe, expect, it } from 'vitest'
import { isWorkspaceColor, nextColor, resolveColors, WORKSPACE_COLORS } from '@ui/features/workspace/model'

// WORKSPACE COLOUR ALLOCATION.
//
// This used to be `WORKSPACE_COLORS[ordinal % 8]`, which is a promise the ordinal cannot keep:
// ordinals are pane-id anchors, so they only climb and are never recycled. Ordinals 0 and 8 are
// both teal, so TWO open workspaces are enough to collide — a real store had brand orange twice.
//
// The rules that replaced it are subtle enough to be worth pinning: allocate against the LIVE
// set; past the palette, spread the reuse onto the least-worn hue; and on restore, settle good
// claims before allocating anything, so repairing one collision cannot cause another rename.

describe('nextColor', () => {
  it('hands out a free colour while one exists', () => {
    expect(nextColor([])).toBe(WORKSPACE_COLORS[0])
    expect(nextColor([WORKSPACE_COLORS[0]!])).toBe(WORKSPACE_COLORS[1])
  })

  it('never repeats while the palette holds — the collision is unrepresentable', () => {
    const taken: string[] = []
    for (let i = 0; i < WORKSPACE_COLORS.length; i++) taken.push(nextColor(taken))
    expect(new Set(taken).size).toBe(WORKSPACE_COLORS.length)
  })

  // Past the palette there is no honest answer left, so the rule becomes "spread it".
  it('reuses the LEAST-worn colour once the palette is exhausted', () => {
    const taken = [...WORKSPACE_COLORS, WORKSPACE_COLORS[0]!, WORKSPACE_COLORS[1]!]
    // 0 and 1 are worn twice; everything else once. The next must not be one of those two.
    const next = nextColor(taken)
    expect([WORKSPACE_COLORS[0], WORKSPACE_COLORS[1]]).not.toContain(next)
    expect(WORKSPACE_COLORS).toContain(next)
  })

  it('counts a colour however it was spelled', () => {
    const upper = WORKSPACE_COLORS[0]!.toUpperCase()
    expect(nextColor([upper]), 'case must not hide a live claim').not.toBe(WORKSPACE_COLORS[0])
  })
})

describe('isWorkspaceColor', () => {
  it('accepts one of ours, in any case', () => {
    expect(isWorkspaceColor(WORKSPACE_COLORS[0])).toBe(true)
    expect(isWorkspaceColor(WORKSPACE_COLORS[0]!.toUpperCase())).toBe(true)
  })

  it('rejects a retired hex and an absent one', () => {
    expect(isWorkspaceColor('#b5d21b'), 'the pre-01 lime is no longer ours').toBe(false)
    expect(isWorkspaceColor(undefined)).toBe(false)
  })
})

describe('resolveColors', () => {
  it('never changes how many workspaces there are', () => {
    expect(resolveColors([undefined, undefined, undefined])).toHaveLength(3)
  })

  it('always returns colours we own, all distinct', () => {
    const out = resolveColors([undefined, '#b5d21b', WORKSPACE_COLORS[0], undefined])
    for (const c of out) expect(WORKSPACE_COLORS, c).toContain(c)
    expect(new Set(out).size).toBe(out.length)
  })

  // THE rule. A workspace with a valid, unclaimed colour wears it for life; only broken
  // claims move. One pass would let a workspace that has to be recoloured anyway walk up and
  // evict a later workspace's legitimate colour — repairing one collision by causing another.
  it('a good claim is never evicted by a repair', () => {
    const keeper = WORKSPACE_COLORS[3]!
    // index 0 must be recoloured (retired hex); index 1 legitimately owns `keeper`.
    const out = resolveColors(['#b5d21b', keeper])
    expect(out[1], 'the valid claim keeps its colour').toBe(keeper)
    expect(out[0]).not.toBe(keeper)
  })

  it('settles a duplicate pair by moving the SECOND one', () => {
    const dup = WORKSPACE_COLORS[2]!
    const out = resolveColors([dup, dup])
    expect(out[0], 'first claimant keeps it').toBe(dup)
    expect(out[1]).not.toBe(dup)
  })

  it('is stable — resolving an already-resolved set changes nothing', () => {
    const once = resolveColors([undefined, '#b5d21b', WORKSPACE_COLORS[0], undefined])
    expect(resolveColors(once)).toEqual(once)
  })
})
