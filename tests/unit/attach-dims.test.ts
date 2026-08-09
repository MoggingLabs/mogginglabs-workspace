import { describe, expect, it } from 'vitest'
import { attachDims, specDimsUsable } from '../../src/pty-daemon/attach-dims'

// The attach-size reconciliation rule (the "pane renders half its width" root cause):
// the attaching client's viewport is authoritative, tmux-style. ensure() applies what
// this function returns to the EXISTING session; the cases below are the whole contract.

describe('attachDims', () => {
  it('returns the spec dims when they differ from the session (the reattach fix)', () => {
    expect(attachDims({ cols: 168, rows: 42 }, { cols: 80, rows: 24 })).toEqual({ cols: 168, rows: 42 })
  })

  it('returns null when dims already match (a forwarded no-op costs a full ConPTY repaint)', () => {
    expect(attachDims({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
  })

  it('returns null for a spec with no dims (a bare attach must not resize)', () => {
    expect(attachDims({}, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ cols: 100 }, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ rows: 30 }, { cols: 80, rows: 24 })).toBeNull()
  })

  it('refuses dims node-pty would throw on (and the fit minimums: 2 cols / 1 row)', () => {
    expect(attachDims({ cols: 0, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ cols: 80, rows: 0 }, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ cols: -5, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ cols: 1, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ cols: 80.5, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
    expect(attachDims({ cols: NaN, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
  })

  it('accepts the minimum viable grid', () => {
    expect(attachDims({ cols: 2, rows: 1 }, { cols: 80, rows: 24 })).toEqual({ cols: 2, rows: 1 })
  })
})

// The confirmation predicate a deferred launch waits on: equal-to-current dims apply
// nothing (attachDims null) yet still turn a restore's persisted-size GUESS into a fact.
//
// It has a SECOND caller now — PaneSession.resize admits on it before touching the pty.
// transport forwards a client's cols/rows unvalidated, so a single `cols: 0` used to make
// node-pty throw AFTER the session had already recorded the size, and the same-dims dedupe
// then made that wrong belief permanent. The cases below are that guard's contract too.
describe('specDimsUsable', () => {
  it('true for a whole measured grid, including equal-to-current and the minimum', () => {
    expect(specDimsUsable({ cols: 80, rows: 24 })).toBe(true)
    expect(specDimsUsable({ cols: 2, rows: 1 })).toBe(true)
  })

  it('false for absent, torn, sub-floor, or non-integer dims', () => {
    expect(specDimsUsable({})).toBe(false)
    expect(specDimsUsable({ cols: 100 })).toBe(false)
    expect(specDimsUsable({ rows: 30 })).toBe(false)
    expect(specDimsUsable({ cols: 1, rows: 24 })).toBe(false)
    expect(specDimsUsable({ cols: 80, rows: 0 })).toBe(false)
    expect(specDimsUsable({ cols: 80.5, rows: 24 })).toBe(false)
    expect(specDimsUsable({ cols: NaN, rows: 24 })).toBe(false)
  })
})
