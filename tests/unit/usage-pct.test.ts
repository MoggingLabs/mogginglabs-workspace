import { describe, expect, it } from 'vitest'
import { displayPct, windowLiveness } from '@contracts'

// The two rules the alert engine and the renderer must NOT hold separate copies
// of. Both live in @contracts precisely because ui may not import @backend, and
// a rule that cannot be shared gets forked — which is how the codebase ended up
// with two `resetsAt` predicates that disagreed.

const NOW = Date.parse('2026-08-02T12:00:00Z')
const FUTURE = new Date(NOW + 3_600_000).toISOString()
const PAST = new Date(NOW - 3_600_000).toISOString()

describe('windowLiveness', () => {
  it('no boundary published means the window is running', () => {
    expect(windowLiveness({}, NOW)).toBe('live')
    expect(windowLiveness({ resetsAt: undefined }, NOW)).toBe('live')
  })

  it('a future boundary is live, a past one is lapsed', () => {
    expect(windowLiveness({ resetsAt: FUTURE }, NOW)).toBe('live')
    expect(windowLiveness({ resetsAt: PAST }, NOW)).toBe('lapsed')
  })

  it('the boundary instant itself is already lapsed — a window that ends now is over', () => {
    expect(windowLiveness({ resetsAt: new Date(NOW).toISOString() }, NOW)).toBe('lapsed')
  })

  it('an unparseable boundary is UNKNOWN — neither live nor lapsed', () => {
    // The whole point of the tri-state. Collapsing this into `live` let the
    // alert loop fire `capped` on a lane it could not date; collapsing it into
    // `lapsed` silently deleted the lane from the failover scorer.
    expect(windowLiveness({ resetsAt: 'not-a-date' }, NOW)).toBe('unknown')
    expect(windowLiveness({ resetsAt: 'Tuesday-ish' }, NOW)).toBe('unknown')
  })

  it('an EMPTY boundary string is absent, not malformed', () => {
    expect(windowLiveness({ resetsAt: '' }, NOW)).toBe('live')
  })
})

describe('displayPct', () => {
  it('is a no-op on integers — every existing line of copy is unchanged to the byte', () => {
    for (const n of [0, 1, 42, 85, 93, 99, 100]) expect(displayPct(n)).toBe(n)
  })

  it('never rounds UP to 100 — the mirror of the cap that rounding manufactured', () => {
    expect(displayPct(99.5)).toBe(99)
    expect(displayPct(99.9)).toBe(99)
    expect(displayPct(99.999)).toBe(99)
  })

  it('never rounds DOWN to 0 — a lane that has been touched does not read as untouched', () => {
    expect(displayPct(0.2)).toBe(1)
    expect(displayPct(0.001)).toBe(1)
  })

  it('reserves the two boundary values for the real thing', () => {
    expect(displayPct(100)).toBe(100)
    expect(displayPct(140)).toBe(100)
    expect(displayPct(0)).toBe(0)
    expect(displayPct(-3)).toBe(0)
  })

  it('a non-number reads as 0 rather than painting NaN', () => {
    expect(displayPct(Number.NaN)).toBe(0)
    expect(displayPct(Number.POSITIVE_INFINITY)).toBe(100)
    expect(displayPct(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})
