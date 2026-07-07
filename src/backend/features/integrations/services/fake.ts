import type { LinkStatus, ServiceAdapter, ServiceLink } from '@contracts'

// The FAKE service adapter (Phase-8/12) — deterministic fixtures, ZERO network,
// ever. Every LinkStatus state has a fixture here so the smoke, the gallery,
// and the UI can exercise the whole vocabulary. The ref's repo name selects the
// fixture (e.g. "acme/web#1" -> checks green); an unknown ref is a clean error.

type Fixture = Omit<LinkStatus, 'linkId' | 'fetchedAt'>

const FIXTURES: Record<string, Fixture | 'throw'> = {
  green: { health: 'fresh', state: 'open', reviewDecision: 'review-required', checks: 'passing', title: 'Add the widget' },
  failing: { health: 'fresh', state: 'open', reviewDecision: 'review-required', checks: 'failing', title: 'Fix the flaky test' },
  changes: { health: 'fresh', state: 'open', reviewDecision: 'changes-requested', checks: 'passing', title: 'Refactor the store' },
  approved: { health: 'fresh', state: 'open', reviewDecision: 'approved', checks: 'passing', title: 'Ship the button' },
  merged: { health: 'fresh', state: 'merged', checks: 'passing', title: 'Merged: the migration' },
  closed: { health: 'fresh', state: 'closed', title: 'Wontfix: the edge case' },
  draft: { health: 'fresh', state: 'draft', reviewDecision: 'review-required', checks: 'pending', title: 'WIP: the spike' },
  stale: { health: 'stale', state: 'open', reviewDecision: 'review-required', checks: 'passing', title: 'Served stale', reason: 'rate limited — showing last good' },
  error: 'throw'
}

/** The fixture key from a ref: the repo segment of "owner/repo#n". */
function fixtureKey(ref: string): string {
  const m = /^[^/]+\/([^#]+)#/.exec(ref)
  return (m?.[1] ?? '').toLowerCase()
}

export function createFakeAdapter(opts: { configured?: boolean } = {}): ServiceAdapter {
  return {
    id: 'fake',
    async detect() {
      return opts.configured === false ? { ok: false, reason: 'the fake tool is not configured' } : { ok: true }
    },
    async fetch(link: ServiceLink): Promise<LinkStatus> {
      const fx = FIXTURES[fixtureKey(link.ref)]
      if (!fx || fx === 'throw') throw new Error('fixture error — no such object')
      return { linkId: link.id, fetchedAt: Date.now(), ...fx }
    }
  }
}
