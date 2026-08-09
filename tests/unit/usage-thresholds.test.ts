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
  windows: { id?: string; label: string; usedPct: number; resetsAt?: string }[],
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

  it('an unreadable sibling never sorts FIRST — worstPct of nothing is +Infinity, not -Infinity', () => {
    // `Math.max()` of an empty list is -Infinity, which reads as "completely
    // idle" and would make the account we know least about the best suggestion.
    // The eligibility filter also excludes it, so this pins the scorer's own
    // totality rather than relying on someone else's guard.
    const all = [profile('a', 0), profile('b', 1), profile('c', 2), profile('d', 3)]
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const blind = plan('b', [{ label: 'Session (5h)', usedPct: 1, resetsAt: PAST }])
    const warmer = plan('c', [{ label: 'Session (5h)', usedPct: 40, resetsAt: FUTURE }])
    const cooler = plan('d', [{ label: 'Session (5h)', usedPct: 10, resetsAt: FUTURE }])
    expect(suggestFailover(active, [active, blind, warmer, cooler], all, NOW)?.profileId).toBe('d')
  })

  it('an UNDATABLE sibling window is not live either — the two guards now agree', () => {
    // The alert loop and this scorer used to disagree on exactly this input:
    // one treated an unparseable boundary as live, the other as dead.
    const active = plan('a', [{ label: 'Session (5h)', usedPct: 100, resetsAt: FUTURE }])
    const sibling = plan('b', [{ label: 'Session (5h)', usedPct: 10, resetsAt: 'not-a-date' }])
    expect(suggestFailover(active, [active, sibling], mine, NOW)).toBeNull()
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

  it('a cold 100% speaks ONCE — with WARN’s voice, because the ascent was never witnessed', () => {
    // Rewritten, not deleted. It used to expect `capped` here, and that
    // expectation IS the shipped bug: a lane with no stored state is
    // indistinguishable from a renamed one, a migrated one, or a wiped KV, and
    // `capped` covers every pane running that lane. So a first-ever sighting at
    // 100 speaks once, at warn, and keeps the failover suggestion.
    const kv = memKv()
    const alerts = evalAt(kv, 100)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].level).toBe('warn')
    expect(alerts[0].title).not.toContain('usage limit reached')
    expect(evalAt(kv, 100)).toHaveLength(0)
  })

  it('...and the silence holds across the window — a suppressed cap is spent, not deferred', () => {
    const kv = memKv()
    expect(evalAt(kv, 100)).toHaveLength(1)
    expect(evalAt(kv, 100)).toHaveLength(0)
    expect(evalAt(kv, 100)).toHaveLength(0)
    expect(evalAt(kv, 100)).toHaveLength(0)
  })

  it('a KNOWN lane at 100 does fire capped — the net withholds evidence, it does not forbid the level', () => {
    const kv = memKv()
    expect(evalAt(kv, 50)).toHaveLength(0) // the arming tick: silent, but the lane is now on record
    const alerts = evalAt(kv, 100)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].level).toBe('capped')
    expect(alerts[0].title).toContain('usage limit reached')
  })

  it('a warn threshold configured at exactly 100 is superseded by capped', () => {
    const kv = memKv()
    const at = (pct: number): UsageAlert[] =>
      evaluateThresholds(
        [plan('a', [{ label: 'Session (5h)', usedPct: pct, resetsAt: FUTURE }])],
        { ...USAGE_ALERT_DEFAULTS, warn: 100 },
        mine,
        kv,
        NOW
      )
    at(50) // arming tick — see the cold-100 case above
    const alerts = at(100)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].level).toBe('capped')
  })

  it('carries the failover suggestion like warn does — including when capped is withheld', () => {
    // The reason the net is affordable: a suppressed cap still routes the user
    // to the other account, it just does it in a toast instead of an overlay.
    const kv = memKv()
    const cold = evalAt(kv, 100)
    expect(cold[0].level).toBe('warn')
    expect(cold[0].failover).toEqual({ profileId: 'b', profileName: 'b' })
  })

  it('a lapsed lane at 100% says nothing', () => {
    const kv = memKv()
    expect(evalAt(kv, 100, PAST)).toHaveLength(0)
  })

  it('an UNDATABLE boundary can never fire capped — with the datable control alongside', () => {
    // A boundary we cannot parse is neither live nor lapsed. It used to be
    // treated as live by the alert loop and as dead by the failover scorer.
    const garbage = memKv()
    expect(evalAt(garbage, 50, 'not-a-date')).toHaveLength(0) // arms the lane
    const capped = evalAt(garbage, 100, 'not-a-date')
    expect(capped).toHaveLength(1)
    expect(capped[0].level).toBe('warn')
    expect(evalAt(garbage, 100, 'not-a-date')).toHaveLength(0)
    // The control, in the same test: identical sequence, readable boundary.
    const dated = memKv()
    expect(evalAt(dated, 50)).toHaveLength(0)
    expect(evalAt(dated, 100)[0].level).toBe('capped')
  })

  it('an undatable boundary is not STORED, so the lane can still detect its own rollover', () => {
    // Storing it left `Number.isFinite(stored)` false forever: that lane could
    // never see a rollover and never re-armed, silently, for good.
    const kv = memKv()
    expect(evalAt(kv, 96)[0].level).toBe('warn') // arms with a real boundary
    expect(evalAt(kv, 96, 'not-a-date')).toHaveLength(0) // undatable tick: stored boundary untouched
    const nextWindow = new Date(NOW + 2 * 3_600_000).toISOString()
    const reset = evalAt(kv, 5, nextWindow, NOW + 3_700_000)
    expect(reset).toHaveLength(1)
    expect(reset[0].kind).toBe('reset')
  })

  it('boundary advance re-arms; in-tolerance drift does not', () => {
    const kv = memKv()
    expect(evalAt(kv, 50)).toHaveLength(0) // arming tick: silent, but the lane is now on record
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
    expect(evalAt(kv, 50)).toHaveLength(0) // arming tick: silent, but the lane is now on record
    expect(evalAt(kv, 100)[0].level).toBe('capped')
    expect(evalAt(kv, 94)).toHaveLength(0) // prunes 100 (94 <= 95) — warn survives (94 > 90)
    const again = evalAt(kv, 100)
    expect(again).toHaveLength(1)
    expect(again[0].level).toBe('capped')
  })

  it('99.5% is not 100% — the rounding that manufactured caps, with the true-100 control', () => {
    const kv = memKv()
    expect(evalAt(kv, 50)).toHaveLength(0) // arming tick: silent, but the lane is now on record, so `known` cannot be the reason
    const near = evalAt(kv, 99.5)
    expect(near).toHaveLength(1)
    expect(near[0].level).toBe('warn')
    expect(evalAt(kv, 99.5)).toHaveLength(0)
    expect(evalAt(kv, 99.9)).toHaveLength(0)
    expect(evalAt(kv, 100)[0].level).toBe('capped')
  })

  it('a warn at 99.5 does not RENDER as 100% either — the mirror lie', () => {
    const kv = memKv()
    evalAt(kv, 50)
    expect(evalAt(kv, 99.5)[0].usedPct).toBe(99)
    expect(evalAt(kv, 100)[0].usedPct).toBe(100)
  })

  it('a capped alert carries the boundary of the window it names', () => {
    const kv = memKv()
    evalAt(kv, 50)
    expect(evalAt(kv, 100)[0].resetsAt).toBe(FUTURE)
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

describe('lane identity is the id, not the label', () => {
  const mine = [profile('a', 0), profile('b', 1)]
  const cool = plan('b', [{ id: 'five_hour', label: 'Session (5h)', usedPct: 10, resetsAt: FUTURE }])

  const at = (kv: ThresholdKv, id: string, label: string, usedPct: number, profileId = 'a'): UsageAlert[] =>
    evaluateThresholds(
      [plan(profileId, [{ id, label, usedPct, resetsAt: FUTURE }]), cool],
      USAGE_ALERT_DEFAULTS,
      mine,
      kv,
      NOW
    ).filter((a) => a.profileId === profileId)

  it('a LABEL rename keeps the lane state — the rename that shipped the bug', () => {
    // `seven_day_opus` -> `seven_day_fable` really happened, twice. Under label
    // keying the renamed lane read as brand new and re-crossed every level.
    const kv = memKv()
    expect(at(kv, 'seven_day_opus', 'Weekly (Opus)', 50)).toHaveLength(0)
    expect(at(kv, 'seven_day_opus', 'Weekly (Opus)', 100)[0].level).toBe('capped')
    // Same lane, new prose. Silent — and observed across a window, not one tick.
    expect(at(kv, 'seven_day_opus', 'Weekly (Fable)', 100)).toHaveLength(0)
    expect(at(kv, 'seven_day_opus', 'Weekly (Fable)', 100)).toHaveLength(0)
    expect(at(kv, 'seven_day_opus', 'Weekly (Fable)', 100)).toHaveLength(0)
  })

  it('a pre-id LABEL-keyed blob is adopted under the id, once, without re-firing', () => {
    const kv = memKv()
    kv.store.set(
      'usage.thr.claude.a',
      JSON.stringify({ v: 2, lanes: { 'Weekly (Opus)': { fired: [80, 95, 100], lastPct: 100, boundary: FUTURE } } })
    )
    expect(at(kv, 'seven_day_opus', 'Weekly (Opus)', 100)).toHaveLength(0)
    // Promoted on write: the alias retires itself after one poll.
    const after = JSON.parse(kv.store.get('usage.thr.claude.a') ?? '{}') as { lanes: Record<string, unknown> }
    expect(Object.keys(after.lanes)).toEqual(['seven_day_opus'])
  })

  it('an id with no stored lane cannot fire capped, however loudly the number reads', () => {
    const kv = memKv()
    kv.store.set('usage.thr.claude.a', JSON.stringify({ v: 2, lanes: { some_other_lane: { fired: [80, 95, 100] } } }))
    const levels = [1, 2, 3].map(() => at(kv, 'seven_day_fable', 'Weekly (Fable)', 100)[0]?.level)
    expect(levels).toEqual(['warn', undefined, undefined])
  })

  it('a window with no id falls back to a slug of its label, deterministically', () => {
    const kv = memKv()
    const noId = (usedPct: number): UsageAlert[] =>
      evaluateThresholds(
        [plan('a', [{ label: 'Session (5h)', usedPct, resetsAt: FUTURE }]), cool],
        USAGE_ALERT_DEFAULTS,
        mine,
        kv,
        NOW
      ).filter((a) => a.profileId === 'a')
    expect(noId(96)[0].level).toBe('warn')
    expect(noId(96)).toHaveLength(0) // single-fire: the same lane was found again
    expect(Object.keys(JSON.parse(kv.store.get('usage.thr.claude.a') ?? '{}').lanes)).toEqual(['session-5h'])
  })

  it('the v1 legacy blob seeds ONLY the primary lane — and the others stay silent', () => {
    // The v1->v2 migration could only ever describe windows[0]. Every other
    // lane comes back unknown, and unknown must not mean `capped`: this exact
    // migration used to re-fire every non-primary lane already at 100%.
    const kv = memKv()
    kv.store.set('usage.thr.claude.a', JSON.stringify({ epoch: FUTURE, fired: [80, 95] }))
    const alerts = evaluateThresholds(
      [
        plan('a', [
          { id: 'five_hour', label: 'Session (5h)', usedPct: 96, resetsAt: FUTURE },
          { id: 'seven_day', label: 'Weekly', usedPct: 100, resetsAt: FUTURE }
        ]),
        cool
      ],
      USAGE_ALERT_DEFAULTS,
      mine,
      kv,
      NOW
    ).filter((a) => a.profileId === 'a')
    expect(alerts.filter((x) => x.level === 'capped')).toHaveLength(0)
    expect(alerts.find((x) => x.windowLabel === 'Weekly')?.level).toBe('warn')
    expect(alerts.find((x) => x.windowLabel === 'Session (5h)')).toBeUndefined() // 80/95 already spent
  })
})

describe('lane pruning', () => {
  const mine = [profile('a', 0), profile('b', 1)]
  const DAY = 86_400_000
  const at = (kv: ThresholdKv, usedPct: number, now: number): UsageAlert[] =>
    evaluateThresholds(
      [plan('a', [{ id: 'five_hour', label: 'Session (5h)', usedPct, resetsAt: new Date(now + 3_600_000).toISOString() }])],
      USAGE_ALERT_DEFAULTS,
      mine,
      kv,
      now
    )
  const lanesIn = (kv: ReturnType<typeof memKv>): string[] =>
    Object.keys((JSON.parse(kv.store.get('usage.thr.claude.a') ?? '{"lanes":{}}') as { lanes: object }).lanes)

  it('a lane nobody has served in a very long time is dropped', () => {
    const kv = memKv()
    at(kv, 50, NOW)
    kv.store.set(
      'usage.thr.claude.a',
      JSON.stringify({ v: 2, lanes: { five_hour: { fired: [], at: NOW }, dropped_model: { fired: [80], at: NOW - 60 * DAY } } })
    )
    at(kv, 51, NOW)
    expect(lanesIn(kv)).toEqual(['five_hour'])
  })

  it('an UNDATED lane is kept — guessing its age is the kind of guess being cured', () => {
    const kv = memKv()
    at(kv, 50, NOW)
    kv.store.set('usage.thr.claude.a', JSON.stringify({ v: 2, lanes: { five_hour: { fired: [] }, old_shape: { fired: [80] } } }))
    at(kv, 51, NOW)
    expect(lanesIn(kv).sort()).toEqual(['five_hour', 'old_shape'])
  })

  it('a pruned lane that comes BACK cannot fire capped — why pruning is safe at all', () => {
    const kv = memKv()
    at(kv, 50, NOW)
    at(kv, 100, NOW) // capped: the lane is known
    // ...now age it out and serve it again at 100.
    const blob = JSON.parse(kv.store.get('usage.thr.claude.a') ?? '{}') as { v: 2; lanes: Record<string, { at?: number }> }
    blob.lanes.five_hour.at = NOW - 60 * DAY
    kv.store.set('usage.thr.claude.a', JSON.stringify(blob))
    at(kv, 5, NOW) // a tick that prunes (this lane is re-added, the stale one evicted)
    kv.store.set('usage.thr.claude.a', JSON.stringify({ v: 2, lanes: {} }))
    const levels = [1, 2, 3].map(() => at(kv, 100, NOW)[0]?.level)
    expect(levels).toEqual(['warn', undefined, undefined])
  })
})

describe('the default pseudo-lane is adopted only by the SAME account', () => {
  // The seam mints `'default'` when no profile targets a provider, and that
  // lane reads the CLI's own config home. The order-0 profile is created with
  // `env = {}` — the same home — so when one appears, `'default'` really was it.
  // Every other profile points at a different home, i.e. a different account.
  const run = (kv: ThresholdKv, profileId: string, usedPct: number, mine: AgentProfile[]): UsageAlert[] =>
    evaluateThresholds(
      [plan(profileId, [{ id: 'five_hour', label: 'Session (5h)', usedPct, resetsAt: FUTURE }])],
      USAGE_ALERT_DEFAULTS,
      mine,
      kv,
      NOW
    ).filter((a) => a.profileId === profileId)

  it('login-<provider> adopts default — the rename login discovery performs', () => {
    const mine = [profile('login-claude', 0), profile('p-b', 1)]
    const kv = memKv()
    expect(run(kv, 'default', 96, mine)[0].level).toBe('warn')
    expect(run(kv, 'login-claude', 96, mine)).toHaveLength(0)
  })

  it('the ORDER-ZERO profile adopts default — the same home under a real name', () => {
    const mine = [profile('p-a', 0), profile('p-b', 1)]
    const kv = memKv()
    expect(run(kv, 'default', 96, mine)[0].level).toBe('warn')
    expect(run(kv, 'p-a', 96, mine)).toHaveLength(0)
  })

  it('a NON-order-zero profile never inherits it — that is a different account', () => {
    // Adopting here would silence thresholds p-b never crossed AND strip the
    // history from p-a, which is the profile it actually belongs to.
    const mine = [profile('p-a', 0), profile('p-b', 1)]
    const kv = memKv()
    expect(run(kv, 'default', 96, mine)[0].level).toBe('warn')
    expect(run(kv, 'p-b', 96, mine)[0].level).toBe('warn')
    // ...and p-a's inheritance is still intact afterwards.
    expect(run(kv, 'p-a', 96, mine)).toHaveLength(0)
  })

  it('adoption is ONE-SHOT — the tombstone stops a second claimant', () => {
    const kv = memKv()
    expect(run(kv, 'default', 96, [profile('p-a', 0)])[0].level).toBe('warn')
    expect(run(kv, 'p-a', 96, [profile('p-a', 0)])).toHaveLength(0) // p-a took it
    // A different lineup now makes p-b order-zero; the history is already spent.
    expect(run(kv, 'p-b', 96, [profile('p-b', 0)])[0].level).toBe('warn')
  })

  it('an adopting profile still fires capped, once, on a level default never crossed', () => {
    const mine = [profile('p-a', 0)]
    const kv = memKv()
    run(kv, 'default', 96, mine) // fires quiet+warn, never 100
    const levels = [1, 2, 3].map(() => run(kv, 'p-a', 100, mine)[0]?.level)
    expect(levels).toEqual(['capped', undefined, undefined])
  })
})
