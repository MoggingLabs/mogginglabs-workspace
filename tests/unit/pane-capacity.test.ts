import { describe, expect, it } from 'vitest'
import { ABS_MAX_PANES } from '../../src/contracts'
import { MAX_LEAVES, MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from '../../src/ui/features/layout/layout-tree'
import { paneCapacity, PANE_SEAM_PX } from '../../src/ui/features/layout/pane-capacity'

// The capacity model is the foundation the pane limit stands on: columns and rows
// are what a screen fits at the pane minima (seams included), the budget is their
// product under the contract ceiling. Pure math — so it gets pinned here.

describe('pane capacity', () => {
  it('a small panel fits few panes — the geometric limit binds', () => {
    const cap = paneCapacity(500, 400)
    expect(cap.maxCols).toBe(Math.floor((500 + PANE_SEAM_PX) / (MIN_PANE_WIDTH_PX + PANE_SEAM_PX)))
    expect(cap.maxRows).toBe(Math.floor((400 + PANE_SEAM_PX) / (MIN_PANE_HEIGHT_PX + PANE_SEAM_PX)))
    expect(cap.maxPanes).toBe(cap.maxCols * cap.maxRows)
    expect(cap.maxPanes).toBeLessThan(ABS_MAX_PANES)
  })

  it('a desktop screen hits the contract ceiling, never beyond', () => {
    const cap = paneCapacity(2560, 1440)
    expect(cap.maxPanes).toBe(ABS_MAX_PANES)
  })

  it('exact boundaries: n panes fit when the span is exactly n minima + seams', () => {
    const n = 4
    const width = n * MIN_PANE_WIDTH_PX + (n - 1) * PANE_SEAM_PX
    expect(paneCapacity(width, MIN_PANE_HEIGHT_PX).maxCols).toBe(n)
    expect(paneCapacity(width - 1, MIN_PANE_HEIGHT_PX).maxCols).toBe(n - 1)
    const height = 2 * MIN_PANE_HEIGHT_PX + PANE_SEAM_PX
    expect(paneCapacity(width, height).maxRows).toBe(2)
    expect(paneCapacity(width, height).maxPanes).toBe(8)
  })

  it('never returns less than one pane, whatever the screen claims', () => {
    expect(paneCapacity(0, 0)).toEqual({ maxCols: 1, maxRows: 1, maxPanes: 1 })
    expect(paneCapacity(-100, 50).maxPanes).toBe(1)
  })

  it('the ceiling aliases persistence: a capacity result always fits the slot-id space', () => {
    expect(paneCapacity(100000, 100000).maxPanes).toBe(ABS_MAX_PANES)
    // layout-tree is deliberately dependency-free (the layout-invariants gate runs it
    // standalone), so its MAX_LEAVES restates the contract number — THIS is the pin
    // that keeps the persistence ceiling and the capacity bound from drifting apart.
    expect(MAX_LEAVES).toBe(ABS_MAX_PANES)
  })
})
