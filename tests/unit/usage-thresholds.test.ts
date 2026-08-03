import { describe, expect, it } from 'vitest'
import { evaluateThresholds, suggestFailover, type ThresholdKv } from '@backend/features/usage/thresholds'
import { USAGE_ALERT_DEFAULTS, type AgentProfile, type UsageAlert } from '@contracts'
import type { PlanUsageView } from '@contracts'

// The threshold engine, verified headless (audit F7 — this logic was smoke-only).
// Two suites: the F5 fix (suggestFailover judges siblings on LIVE windows only)
// and the `capped` 100% level goldens (single-fire, re-arm, supersede) that the
// pane-failover trigger rides.

const NOW = Date.parse('2026-08-02T12:00:00Z')
const FUTURE = new Date(NOW + 3_600_000).toISOString()
const PAST = new Date(NOW - 3_600_000).toISOString()

const profile = (id: string, order: number, provider = 'claude'): AgentProfile => ({
  id,
  name: id,
  provider,
  env: {},
  order
})

const plan = (
  profileId: string,
  windows: { label: string; usedPct: number; resetsAt?: string }[],
  overrides: Partial<PlanUsageView> = {}
): PlanUsageView => ({
  providerId: 'claude',
  profileId,
  planLabel: `Plan ${profileId}`,
  windows,
  fetchedAt: NOW,
  health: 'fresh',
  ...overrides
})

const memKv = (): ThresholdKv & { store: Map<string, string> } => {
  const store = new Map<string, string>()
  return { store, get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) }
}

describe('suggestFailover (F5: live windows only)', () => {
  const mine = [profile('a', 0), profile('b', 1)]

  it('suggests a sibling whose only hot window has already reset', () => {
    // Pre-fix: the lapsed weekly at 90% pinned worstPct and suppressed the
    // suggestion exactly when the lane had just become the best one.
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const sibling = plan('b', [
      { label: 'Weekly', usedPct: 90, resetsAt: PAST },
      { label: 'Session (5h)', usedPct: 10, resetsAt: FUTURE }
    ])
    expect(suggestFailover(active, [active, sibling], mine, NOW)).toEqual({ profileId: 'b', profileName: 'b' })
  })

  it('rejects a sibling whose LIVE window is hot', () => {
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const sibling = plan('b', [{ label: 'Session (5h)', usedPct: 60, resetsAt: FUTURE }])
    expect(suggestFailover(active, [active, sibling], mine, NOW)).toBeNull()
  })

  it('excludes a sibling with no live window at all (stale says nothing)', () => {
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const sibling = plan('b', [{ label: 'Session (5h)', usedPct: 10, resetsAt: PAST }])
    expect(suggestFailover(active, [active, sibling], mine, NOW)).toBeNull()
  })

  it('windows without resetsAt count as live', () => {
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const sibling = plan('b', [{ label: 'Session (5h)', usedPct: 12 }])
    expect(suggestFailover(active, [active, sibling], mine, NOW)).toEqual({ profileId: 'b', profileName: 'b' })
  })

  it('only the ACTIVE plan suggests a lane change', () => {
    const inactive = plan('b', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const cool = plan('a', [{ label: 'Session (5h)', usedPct: 5, resetsAt: FUTURE }])
    expect(suggestFailover(inactive, [inactive, cool], mine, NOW)).toBeNull()
  })

  it('picks the coolest live sibling among several', () => {
    const all = [profile('a', 0), profile('b', 1), profile('c', 2)]
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const warmer = plan('b', [{ label: 'Session (5h)', usedPct: 40, resetsAt: FUTURE }])
    const cooler = plan('c', [{ label: 'Session (5h)', usedPct: 15, resetsAt: FUTURE }])
    expect(suggestFailover(active, [active, warmer, cooler], all, NOW)?.profileId).toBe('c')
  })
})

describe('capped level (100%)', () => {
  const mine = [profile('a', 0), profile('b', 1)]
  const coolSibling = plan('b', [{ label: 'Session (5h)', usedPct: 10, resetsAt: FUTURE }])

  const evalAt = (kv: ThresholdKv, pct: number, resetsAt = FUTURE, now = NOW): UsageAlert[] =>
    evaluateThresholds(
      [plan('a', [{ label: 'Session (5h)', usedPct: pct, resetsAt }]), coolSibling],
      USAGE_ALERT_DEFAULTS,
      mine,
      kv,
      now
    ).filter((a) => a.profileId === 'a')

  it('a 96→100 climb fires warn once, then capped once, then nothing', () => {
    const kv = memKv()
    const first = evalAt(kv, 96)
    expect(first).toHaveLength(1)
    expect(first[0].level).toBe('warn')
    const second = evalAt(kv, 100)
    expect(second).toHaveLength(1)
    expect(second[0].level).toBe('capped')
    expect(second[0].title).toContain('usage limit reached')
    expect(evalAt(kv, 100)).toHaveLength(0) // single-fire
  })

  it('a cold 100% speaks ONCE with capped voice (quiet/warn spent silently)', () => {
    const kv = memKv()
    const alerts = evalAt(kv, 100)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].level).toBe('capped')
    expect(evalAt(kv, 100)).toHaveLength(0)
  })

  it('a warn threshold configured at exactly 100 is superseded by capped', () => {
    const kv = memKv()
    const alerts = evaluateThresholds(
      [plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])],
      { ...USAGE_ALERT_DEFAULTS, warn: 100 },
      mine,
      kv,
      NOW
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].level).toBe('capped')
  })

  it('carries the failover suggestion like warn does', () => {
    const kv = memKv()
    const alerts = evalAt(kv, 100)
    expect(alerts[0].failover).toEqual({ profileId: 'b', profileName: 'b' })
  })

  it('a lapsed lane at 100% says nothing', () => {
    const kv = memKv()
    expect(evalAt(kv, 100, PAST)).toHaveLength(0)
  })

  it('boundary advance re-arms; in-tolerance drift does not', () => {
    const kv = memKv()
    expect(evalAt(kv, 100)[0].level).toBe('capped')
    // Same window: resets_at churn inside the 2min tolerance.
    const drift = new Date(NOW + 3_600_000 + 60_000).toISOString()
    expect(evalAt(kv, 100, drift)).toHaveLength(0)
    // A real rollover — the boundary ADVANCED — re-arms the lane; still capped
    // means the fresh window crossed 100 again and fires again.
    const nextWindow = new Date(NOW + 2 * 3_600_000).toISOString()
    const again = evalAt(kv, 100, nextWindow, NOW + 3_700_000)
    expect(again).toHaveLength(1)
    expect(again[0].level).toBe('capped')
  })

  it('descent below the re-arm margin re-arms capped (but not warn)', () => {
    const kv = memKv()
    expect(evalAt(kv, 100)[0].level).toBe('capped')
    expect(evalAt(kv, 94)).toHaveLength(0) // prunes 100 (94 <= 95) — warn survives (94 > 90)
    const again = evalAt(kv, 100)
    expect(again).toHaveLength(1)
    expect(again[0].level).toBe('capped')
  })

  it('the spend cap keeps the plain quiet/warn ladder (no capped)', () => {
    const kv = memKv()
    const spendPlan = plan('a', [], {
      spend: { amount: 100, currency: 'USD', limit: 100 }
    })
    const alerts = evaluateThresholds([spendPlan], USAGE_ALERT_DEFAULTS, mine, kv, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].windowLabel).toBe('spend')
    expect(alerts[0].level).toBe('warn')
  })
})
