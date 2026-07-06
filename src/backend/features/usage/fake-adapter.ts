import { readFileSync } from 'node:fs'
import type { PlanUsage, UsageAdapter } from '@contracts'

// The FAKE usage adapter (Phase-7/01). First-class citizen FOREVER: every
// smoke and every gallery state runs on it — zero network is structural, not
// disciplined. Fixtures are deterministic; `MOGGING_USAGE_FIXTURE` (a JSON
// file of PlanUsage[]) overrides the built-ins; `setFakeMode` lets a smoke
// stage the error/backoff/stale ladder.

type FakeMode = 'ok' | 'error'
let mode: FakeMode = 'ok'

/** Smoke hook: flip the adapter into failure so the seam's stale/backoff
 *  behavior can be asserted without any real provider. */
export function setFakeMode(m: FakeMode): void {
  mode = m
}

/** Deterministic clock base so fixtures don't drift mid-smoke. */
const T0 = Date.now()
const HOUR = 3_600_000

const builtinFixtures = (): PlanUsage[] => [
  {
    providerId: 'fake',
    profileId: 'default',
    planLabel: 'Fake Pro (normal)',
    windows: [
      { label: 'Session (5h)', usedPct: 42, resetsAt: new Date(T0 + 3 * HOUR).toISOString() },
      { label: 'Weekly', usedPct: 31, resetsAt: new Date(T0 + 96 * HOUR).toISOString() }
    ],
    fetchedAt: T0,
    health: 'fresh'
  },
  {
    providerId: 'fake',
    profileId: 'near-limit',
    planLabel: 'Fake Pro (near limit)',
    windows: [
      { label: 'Session (5h)', usedPct: 91, resetsAt: new Date(T0 + 1 * HOUR).toISOString() },
      { label: 'Weekly', usedPct: 74, resetsAt: new Date(T0 + 40 * HOUR).toISOString() }
    ],
    fetchedAt: T0,
    health: 'fresh'
  },
  {
    providerId: 'fake',
    profileId: 'exhausted',
    planLabel: 'Fake Pro (exhausted)',
    windows: [
      { label: 'Session (5h)', usedPct: 100, resetsAt: new Date(T0 + 2 * HOUR).toISOString() },
      { label: 'Weekly', usedPct: 100, resetsAt: new Date(T0 + 12 * HOUR).toISOString() }
    ],
    fetchedAt: T0,
    health: 'fresh'
  },
  {
    providerId: 'fake',
    profileId: 'fresh-reset',
    planLabel: 'Fake Pro (fresh reset)',
    windows: [
      { label: 'Session (5h)', usedPct: 0, resetsAt: new Date(T0 + 5 * HOUR).toISOString() },
      { label: 'Weekly', usedPct: 2, resetsAt: new Date(T0 + 160 * HOUR).toISOString() }
    ],
    fetchedAt: T0,
    health: 'fresh'
  },
  {
    providerId: 'fake',
    profileId: 'stale',
    planLabel: 'Fake Pro (stale)',
    windows: [{ label: 'Session (5h)', usedPct: 55, resetsAt: new Date(T0 + 2 * HOUR).toISOString() }],
    fetchedAt: T0 - 2 * HOUR,
    health: 'stale',
    reason: 'provider unreachable — showing data from 2h ago'
  },
  {
    providerId: 'fake',
    profileId: 'error',
    planLabel: 'Fake Pro (error)',
    windows: [],
    fetchedAt: T0,
    health: 'error',
    reason: 'token expired — sign in again with the CLI'
  },
  {
    providerId: 'fake',
    profileId: 'unconfigured',
    planLabel: 'Fake Pro (unconfigured)',
    windows: [],
    fetchedAt: T0,
    health: 'unconfigured',
    reason: 'CLI not installed'
  },
  // ── 7/04 normalization-path fixtures: every shape a cli-store row can emit ──
  {
    providerId: 'fake',
    profileId: 'credits',
    planLabel: 'Fake (credit balance)',
    windows: [{ label: 'Credits', usedPct: 0, windowMs: 0 }],
    credits: { label: 'credits', remaining: 4200 },
    fetchedAt: T0,
    health: 'fresh'
  },
  {
    providerId: 'fake',
    profileId: 'daily',
    planLabel: 'Fake (daily quota)',
    windows: [{ label: 'Daily', usedPct: 67, resetsAt: new Date(T0 + 8 * HOUR).toISOString(), windowMs: 24 * HOUR }],
    fetchedAt: T0,
    health: 'fresh'
  },
  // ── 7/07: the spend shape — a current-window spend rides the plan.
  {
    providerId: 'fake',
    profileId: 'spend',
    planLabel: 'Fake (monthly spend)',
    windows: [{ label: 'Monthly', usedPct: 34, resetsAt: new Date(T0 + 400 * HOUR).toISOString(), windowMs: 720 * HOUR }],
    spend: { amount: 12.34, currency: 'USD' },
    fetchedAt: T0,
    health: 'fresh'
  },
  {
    providerId: 'fake',
    profileId: 'multi-lane',
    planLabel: 'Fake (3-lane)',
    windows: [
      { label: 'Session (5h)', usedPct: 48, resetsAt: new Date(T0 + 2 * HOUR).toISOString(), windowMs: 5 * HOUR },
      { label: 'Weekly', usedPct: 61, resetsAt: new Date(T0 + 80 * HOUR).toISOString(), windowMs: 168 * HOUR },
      { label: 'Monthly', usedPct: 23, resetsAt: new Date(T0 + 500 * HOUR).toISOString(), windowMs: 720 * HOUR }
    ],
    fetchedAt: T0,
    health: 'fresh'
  }
]

export const fakeAdapter: UsageAdapter = {
  id: 'fake',
  detect: async () => ({ ok: true }),
  fetch: async (_home, _profileId, _signal) => {
    if (mode === 'error') throw new Error('fixture: provider unreachable')
    const file = process.env.MOGGING_USAGE_FIXTURE
    if (file) return JSON.parse(readFileSync(file, 'utf8')) as PlanUsage[]
    return builtinFixtures()
  }
}
