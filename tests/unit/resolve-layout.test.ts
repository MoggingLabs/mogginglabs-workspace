import { describe, expect, it } from 'vitest'
import { ABS_MAX_PANES } from '../../src/contracts'
import { resolveLayout } from '../../src/backend/features/templates/resolve'

// resolveLayout speaks two dialects since the capacity work; this suite pins BOTH so
// neither the template callers' legacy contract nor the painter's exact mode can drift.

describe('resolveLayout', () => {
  it('default: pads to the smallest curated grid (the pre-capacity contract)', () => {
    const r = resolveLayout([
      { provider: 'shell', count: 2 },
      { provider: 'claude', count: 1 }
    ])
    expect(r.paneCount).toBe(4)
    expect(r.assignments).toHaveLength(4)
    expect(r.assignments.filter((a) => a === 'claude')).toHaveLength(1)
  })

  it('default: oversized mixes still cap at the largest curated grid — 16, as always', () => {
    const r = resolveLayout([{ provider: 'shell', count: 20 }])
    expect(r.paneCount).toBe(16)
    expect(r.assignments).toHaveLength(16)
  })

  it('exact: the total IS the layout, up to the contract ceiling', () => {
    expect(resolveLayout([{ provider: 'shell', count: 3 }], true).paneCount).toBe(3)
    const big = resolveLayout([{ provider: 'shell', count: 500 }], true)
    expect(big.paneCount).toBe(ABS_MAX_PANES)
    expect(big.assignments).toHaveLength(ABS_MAX_PANES)
  })

  it('hostile counts cannot expand past the cap (the in-loop guard)', () => {
    const r = resolveLayout([{ provider: 'shell', count: Number.MAX_SAFE_INTEGER }])
    expect(r.assignments).toHaveLength(16)
    const rExact = resolveLayout([{ provider: 'shell', count: Infinity }], true)
    expect(rExact.assignments.length).toBeLessThanOrEqual(ABS_MAX_PANES)
  })

  it('an empty mix opens one shell', () => {
    expect(resolveLayout([])).toEqual({ paneCount: 1, assignments: ['shell'] })
    expect(resolveLayout([], true)).toEqual({ paneCount: 1, assignments: ['shell'] })
  })
})
