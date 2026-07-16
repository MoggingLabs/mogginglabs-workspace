import { describe, expect, it } from 'vitest'
import { ABS_MAX_PANES } from '../../src/contracts'
import { MAX_LEAVES, MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from '../../src/ui/features/layout/layout-tree'
import {
  effectivePaneCapacity,
  machinePaneBudget,
  paneCapacity,
  MACHINE_RESERVE_MB,
  PANE_BUDGET_MB,
  PANE_SEAM_PX,
  PANES_PER_CORE
} from '../../src/ui/features/layout/pane-capacity'

// The capacity model is the foundation the pane limit stands on: columns and rows
// are what a screen fits at the pane minima (seams included), the budget is their
// product under the contract ceiling — and since the wizard revamp, the MACHINE
// (RAM/CPU) is a second dimension of the same budget. Pure math — pinned here.

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

describe('machine pane budget', () => {
  it('pins the policy constants — moving one is a deliberate review, not a drift', () => {
    expect(PANE_BUDGET_MB).toBe(512)
    expect(MACHINE_RESERVE_MB).toBe(4096)
    expect(PANES_PER_CORE).toBe(2)
  })

  it('memory binds a fat-core laptop; cpu binds a lean-core box; the ceiling caps monsters', () => {
    // 16 GiB / 12 threads (a common dev laptop): memory (23) under cpu (24).
    expect(machinePaneBudget({ cpuCount: 12, totalMemMb: 16384 })).toBe(24)
    expect(machinePaneBudget({ cpuCount: 12, totalMemMb: 16223 })).toBe(23)
    // 32 GiB / 4 threads: cpu (8) under memory (56).
    expect(machinePaneBudget({ cpuCount: 4, totalMemMb: 32768 })).toBe(8)
    // 128 GiB / 32 threads: both above the contract ceiling.
    expect(machinePaneBudget({ cpuCount: 32, totalMemMb: 131072 })).toBe(ABS_MAX_PANES)
    // 4 GiB netbook: the reserve eats everything — but one terminal is always allowed.
    expect(machinePaneBudget({ cpuCount: 2, totalMemMb: 4096 })).toBe(1)
  })

  it('the effective budget is geometry ∧ machine, minus panes already running', () => {
    // No host, no window in this test env: geometry falls back to the laptop panel.
    const spec = { cpuCount: 12, totalMemMb: 16384 } // machine budget 24
    const idle = effectivePaneCapacity(null, spec, 0)
    expect(idle.machineMaxPanes).toBe(24)
    expect(idle.maxPanes).toBe(Math.min(idle.screenMaxPanes, 24))
    // 20 panes already running: 4 left — the machine term charges them.
    const busy = effectivePaneCapacity(null, spec, 20)
    expect(busy.maxPanes).toBe(Math.min(busy.screenMaxPanes, 4))
    expect(busy.panesElsewhere).toBe(20)
    // Saturated machine: the floor is ONE terminal, never zero.
    expect(effectivePaneCapacity(null, spec, 99).maxPanes).toBe(1)
    // No spec (channel unanswered, tests): the geometry-only world, unchanged.
    const bare = effectivePaneCapacity(null, null, 5)
    expect(bare.maxPanes).toBe(bare.screenMaxPanes)
    expect(bare.machineMaxPanes).toBeNull()
    expect(bare.limitedBy === 'screen' || bare.limitedBy === 'ceiling').toBe(true)
  })

  it('says WHY it stopped: memory vs cpu vs ceiling vs screen', () => {
    expect(effectivePaneCapacity(null, { cpuCount: 12, totalMemMb: 8192 }, 0).limitedBy).toBe('memory') // budget 8
    expect(effectivePaneCapacity(null, { cpuCount: 2, totalMemMb: 32768 }, 0).limitedBy).toBe('cpu') // budget 4
    const roomy = effectivePaneCapacity(null, { cpuCount: 32, totalMemMb: 131072 }, 0)
    expect(roomy.limitedBy === 'screen' || roomy.limitedBy === 'ceiling').toBe(true)
  })
})
