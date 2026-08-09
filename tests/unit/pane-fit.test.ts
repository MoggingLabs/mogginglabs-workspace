import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gridFor, MIN_COLS, MIN_ROWS, publishableCell } from '@ui/features/terminal/pane-fit'

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
    // used to have to re-run this derivation, and why publishableCell now removes
    // the divergence upstream of it (see below).
    expect(gridFor(800, 400, 8.4, 18.2)!.cols).toBe(95)
    expect(gridFor(800, 400, 8.0, 18.2)!.cols).toBe(100)
  })
})

describe('publishableCell — the same pane must propose one grid, not two', () => {
  // The renderers disagree about cell WIDTH: WebGL floors charWidth at device pixels and
  // the DOM renderer uses the raw product. So a pane's proposal used to change with
  // whichever renderer happened to be attached — a property that flips on GPU events the
  // user never caused (the context cap, hidden-pane eviction, a driver reset), and every
  // flip put a resize on the wire, mid-frame, into a live agent.
  //
  // These are DEVICE cells, which is why the collapse is exact: WebGL's is already an
  // integer so floor is idempotent on it, and the DOM's is the raw product. (Flooring the
  // CSS cell would not do — the DOM renderer's carries a round(·cols)/cols residue that
  // depends on the current column count.)
  const CHAR_W = 8.4 // JetBrains Mono at the default 14px: 0.6em advance
  const CHAR_H = 18.48 // ...and its 1.32em line box

  const domCell = (dpr: number): { width: number; height: number } => ({
    width: CHAR_W * dpr,
    height: Math.floor(Math.ceil(CHAR_H * dpr) * 1.3)
  })
  const webglCell = (dpr: number): { width: number; height: number } => ({
    width: Math.floor(CHAR_W * dpr),
    height: Math.floor(Math.ceil(CHAR_H * dpr) * 1.3)
  })

  it('collapses the two renderers onto the same published cell at every scaling', () => {
    // THE assertion that fails if the floor is ever reverted.
    for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
      expect(publishableCell(domCell(dpr), dpr), `dpr ${dpr}`).toEqual(publishableCell(webglCell(dpr), dpr))
    }
  })

  it('is idempotent — a published cell republishes to itself', () => {
    for (const dpr of [1, 1.25, 2]) {
      const once = publishableCell(domCell(dpr), dpr)
      expect(publishableCell({ width: once.width * dpr, height: once.height * dpr }, dpr)).toEqual(once)
    }
  })

  it('leaves heights alone — both renderers already compute the identical device cell', () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      expect(publishableCell(domCell(dpr), dpr).height).toBe(domCell(dpr).height / dpr)
    }
  })

  it('yields the WebGL grid — the floored cell is NARROWER, so it fits MORE columns', () => {
    // Worth pinning because the direction is counter-intuitive and the trade depends on it.
    const cell = publishableCell(domCell(1.25), 1.25)
    expect(cell.width).toBe(8)
    expect(gridFor(800, 400, cell.width, cell.height)!.cols).toBe(100)
  })

  it('passes the cell through unharmed when the ratio is unusable', () => {
    const cell = { width: 10.5, height: 31 }
    expect(publishableCell(cell, 0)).toEqual(cell)
    expect(publishableCell(cell, NaN)).toEqual(cell)
  })
})
