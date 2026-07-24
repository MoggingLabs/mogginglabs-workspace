import { describe, expect, it } from 'vitest'
import { gridFor, MIN_COLS, MIN_ROWS } from '@ui/features/terminal/pane-fit'

// The house grid derivation that retired @xterm/addon-fit. The one deliberate
// difference from the addon is the ABSENCE of its scrollbar reservation
// (`overviewRuler?.width || 14`): this app's native scrollbar is retired and the
// overlay slider lives in .pane-body's padding, so the content box is the
// terminal's to fill completely. The first test pins exactly that.

describe('gridFor', () => {
  it('fills the whole content box — no phantom scrollbar lane', () => {
    // 800px at 8.4px cells: FitAddon would compute floor((800-14)/8.4) = 93 cols,
    // a ~14px dead strip at the right edge. The house derivation uses all 800.
    expect(gridFor(800, 400, 8.4, 18.2)).toEqual({ cols: 95, rows: 21 })
  })

  it('floors to whole cells (the sub-cell remainder is the only dead space allowed)', () => {
    expect(gridFor(100, 100, 10, 10)).toEqual({ cols: 10, rows: 10 })
    expect(gridFor(109.9, 100, 10, 10)).toEqual({ cols: 10, rows: 10 })
    expect(gridFor(110, 100, 10, 10)).toEqual({ cols: 11, rows: 10 })
  })

  it('clamps to the minimum viable grid instead of underflowing', () => {
    expect(gridFor(1, 1, 10, 10)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
    expect(gridFor(0, 0, 10, 10)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS })
  })

  it('returns null when the cell is unmeasured (hidden pane) or the box is unreadable', () => {
    expect(gridFor(800, 400, 0, 18)).toBeNull()
    expect(gridFor(800, 400, 8.4, 0)).toBeNull()
    expect(gridFor(NaN, 400, 8.4, 18.2)).toBeNull()
    expect(gridFor(800, NaN, 8.4, 18.2)).toBeNull()
  })

  it('honours fractional cell widths exactly (the dpr-divergence case)', () => {
    // The same 800px box under the two renderers at dpr 1.25: the DOM renderer
    // measures 8.4px, WebGL floors to device pixels and reports 8.0px. Different
    // renderers, different (both correct) grids — which is why a renderer swap
    // must re-run this derivation.
    expect(gridFor(800, 400, 8.4, 18.2)!.cols).toBe(95)
    expect(gridFor(800, 400, 8.0, 18.2)!.cols).toBe(100)
  })
})
