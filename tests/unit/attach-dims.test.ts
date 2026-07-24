import { describe, expect, it } from 'vitest'
import { attachDims } from '../../src/pty-daemon/attach-dims'

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
