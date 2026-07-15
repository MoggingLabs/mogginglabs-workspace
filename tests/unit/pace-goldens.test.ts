import { describe, expect, it } from 'vitest'
import { computePace, formatVerdict } from '@backend/features/usage/pace'
import { PACE_GOLDENS } from '@backend/features/usage/pace-fixtures'

// The golden pace table, verified headless. The MOGGING_USAGE gate runs the SAME
// fixtures inside a booted app; this tier catches a drifted verdict, delta, or wording
// in seconds instead of a full sweep. Both iterate PACE_GOLDENS itself, so a new
// fixture is picked up by both without registration.
describe('pace goldens', () => {
  for (const g of PACE_GOLDENS) {
    it(g.name, () => {
      const report = computePace(g.window, g.now, g.opts)
      if (g.expect === null) {
        expect(report).toBeNull()
        return
      }
      expect(report).not.toBeNull()
      expect(report!.verdict).toBe(g.expect.verdict)
      expect(Math.round(report!.paceDelta)).toBe(g.expect.deltaRounded)
      expect(formatVerdict(report!, g.window.label)).toBe(g.expect.text)
    })
  }
})
