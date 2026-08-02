import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gridFor, MIN_COLS, MIN_ROWS } from '@ui/features/terminal/pane-fit'

// The house grid derivation that retired @xterm/addon-fit. The one deliberate
// difference from the addon is the ABSENCE of its scrollbar reservation
// (`overviewRuler?.width || 14`): this app's native scrollbar is retired and the
// overlay slider lives in .pane-body's padding, so the content box is the
// terminal's to fill completely. The first test pins exactly that.

describe('spawn sends the PROPOSAL, not xterm’s current grid', () => {
  // terminal-pane.ts is renderer code and cannot be instantiated here, so this is asserted
  // over its source.
  //
  // The spawn payload used to compute `proposeGrid(this.term) !== null`, keep only the
  // boolean, and then send `this.term.cols`/`this.term.rows` — a DIFFERENT quantity.
  // proposeGrid says what the grid should be given the container; term.cols says what xterm
  // currently holds. They agree only after a fit has been applied. Before the first one, a
  // perfectly measurable pane still holds xterm's 80x24 default, so the guard passed and
  // 80x24 was sent — resizing a surviving agent session to the wrong grid, which is exactly
  // what the guard was written to prevent.
  const src = readFileSync(resolve(import.meta.dirname, '../../src/ui/features/terminal/terminal-pane.ts'), 'utf8')
  const payload = src.slice(src.indexOf('return terminalClient'), src.indexOf('.then((res)'))

  it('reads the proposal once and sends it', () => {
    expect(payload).toContain('cols: grid?.cols')
    expect(payload).toContain('rows: grid?.rows')
  })

  it('never sends xterm’s current grid as the spawn dims', () => {
    expect(payload).not.toMatch(/(?:cols|rows):[^,\n]*this\.term\.(?:cols|rows)/)
  })

  it('measures exactly once — a torn read cannot disagree with itself', () => {
    const spawnPty = src.slice(src.indexOf('private spawnPty'), src.indexOf('.then((res)'))
    expect(spawnPty.match(/proposeGrid\(this\.term\)/g) ?? []).toHaveLength(1)
  })
})

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
