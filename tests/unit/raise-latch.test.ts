import { describe, expect, it } from 'vitest'
import { createRaiseLatch } from '@ui/core/raise-latch'

// LEVEL vs TRANSITION, pinned — the second time this codebase confused them.
//
// The settings card auto-opens "the first time attention is raised". Nothing recorded
// whether it already had, and setAttention runs on EVERY push — so a hot plan or an
// expired connection, which hold attention raised, re-opened a card the user had just
// collapsed by hand, on every poll tick. Disclosure persistence worked reliably except
// while attention was active, which is exactly when someone is most likely to be tidying
// the section away.
//
// The bridge made the same mistake about `needs-you` (PaneStateHistory). Both read the
// same on the page — `if (raised) …` — and both fire continuously where they meant once.

describe('createRaiseLatch', () => {
  it('fires once on the way up, not while held', () => {
    const rose = createRaiseLatch()
    expect(rose(true)).toBe(true)
    expect(rose(true)).toBe(false)
    expect(rose(true)).toBe(false)
  })

  it('re-arms after the level drops', () => {
    const rose = createRaiseLatch()
    expect(rose(true)).toBe(true)
    expect(rose(false)).toBe(false)
    expect(rose(true)).toBe(true)
  })

  it('starts low — a first call with false is not a transition', () => {
    const rose = createRaiseLatch()
    expect(rose(false)).toBe(false)
    expect(rose(false)).toBe(false)
  })

  it('the repeated-push case, end to end', () => {
    // Exactly the shipped sequence: attention raised, then re-delivered unchanged by each
    // poll tick while the user collapses the card in between.
    const rose = createRaiseLatch()
    const fired: number[] = []
    for (let tick = 0; tick < 10; tick++) if (rose(true)) fired.push(tick)
    expect(fired).toEqual([0])
  })

  it('two latches do not share state', () => {
    const a = createRaiseLatch()
    const b = createRaiseLatch()
    expect(a(true)).toBe(true)
    expect(b(true)).toBe(true) // b has its own history
    expect(a(true)).toBe(false)
  })
})
