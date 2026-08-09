import { describe, expect, it } from 'vitest'
import { cappedOfferCopy, laneIdentity, planCappedOffers, type CappedPane } from '@ui/features/agents/capped-offers'
import { laneKeyOf, type CappedLane } from '@ui/core/usage/lane-capped'
import { NO_PROFILE, UNKNOWN_PROFILE, namedProfile } from '@ui/core/agents/pane-profile'

// The heart of the fix: which panes get covered is a FUNCTION OF CURRENT STATE.
// The bug it replaces was a function of a delivered event, and events replay.

// An explicit clock everywhere: the lowering rule reads the offer's boundary
// against `now`, so a default of Date.now() would make these pass or fail
// depending on the wall date.
const NOW = Date.parse('2026-08-03T12:00:00Z')
const RESETS = new Date(NOW + 12 * 3_600_000).toISOString()
const LATER = new Date(NOW + 7 * 86_400_000).toISOString()

const lane = (over: Partial<CappedLane> = {}): CappedLane => ({
  providerId: 'claude',
  profileId: 'cdev',
  windowLabel: 'Weekly',
  resetsAt: RESETS,
  evidence: 'fresh',
  ...over
})

const lanesOf = (...ls: CappedLane[]): ReadonlyMap<string, CappedLane> =>
  new Map(ls.map((l) => [laneKeyOf(l.providerId, l.profileId), l]))

const pane = (paneId: number, over: Partial<CappedPane> = {}): CappedPane => ({
  paneId,
  provider: 'claude',
  profile: namedProfile('cdev'),
  agentPresent: true,
  busy: false,
  holdsOurOffer: false,
  ...over
})

const orderZero = (): string | undefined => 'cdev'
const EMPTY = { raise: [], lower: [], forget: [], holdAmbiguous: [] }

/** A pane already holding OUR offer for `l`, with the boundary we raised it for. */
const holding = (paneId: number, l: CappedLane = lane(), over: Partial<CappedPane> = {}): CappedPane =>
  pane(paneId, {
    holdsOurOffer: true,
    raisedFor: laneIdentity(l),
    ...(l.resetsAt ? { raisedResetsAt: l.resetsAt } : {}),
    ...over
  })

const plan = (
  panes: readonly CappedPane[],
  lanes: ReadonlyMap<string, CappedLane>,
  now = NOW
): ReturnType<typeof planCappedOffers> => planCappedOffers(panes, lanes, true, orderZero, now)

describe('planCappedOffers', () => {
  it('covers every pane genuinely running the spent lane', () => {
    const p = plan([pane(1), pane(2), pane(3)], lanesOf(lane()))
    expect(p.raise.map((r) => r.paneId)).toEqual([1, 2, 3])
    expect(p.lower).toEqual([])
    expect(p.forget).toEqual([])
  })

  // ── THE INCIDENT, in one assertion.
  //
  // Eight live panes and a nudge for a lane the current snapshot does not hold.
  // Under the old design this was an *event* carrying only ids, so it was taken
  // at face value and every pane was covered. The whole result object is
  // asserted, not just `raise`, so "touched nothing" is proven rather than
  // inferred from one absent field.
  it('THE INCIDENT: eight live panes and no capped lane touches nothing at all', () => {
    const eight = Array.from({ length: 8 }, (_, i) => pane(i + 1))
    expect(plan(eight, new Map())).toEqual(EMPTY)
  })

  it('THE BOOT RACE: `laneKnown: false` neither raises NOR lowers, even with a full map', () => {
    // Not "treat as not capped" — decline to act. At renderer mount the outbox
    // drains milliseconds in while the first poll is ~1.5s out; that is exactly
    // the window the shipped bug fired in.
    const eight = Array.from({ length: 8 }, (_, i) => (i === 0 ? holding(1) : pane(i + 1)))
    expect(planCappedOffers(eight, lanesOf(lane()), false, orderZero, NOW)).toEqual(EMPTY)
  })

  it('holds while the lane is exactly what it was raised for', () => {
    expect(plan([holding(1)], lanesOf(lane()))).toEqual(EMPTY)
  })

  it('ANOTHER OWNER: a superseded overlay is forgotten, never lowered', () => {
    // `holdsOurOffer: false` means the port is holding a switching/launching/
    // failed card someone else raised. Clearing it blind destroyed it.
    const stolen = pane(1, { holdsOurOffer: false, agentPresent: false })
    const p = plan([stolen], new Map())
    expect(p.lower).toEqual([])
    expect(p.raise).toEqual([])
  })

  it('a pane whose agent is gone is forgotten, not lowered', () => {
    expect(plan([holding(1, lane(), { agentPresent: false })], lanesOf(lane()))).toEqual({ ...EMPTY, forget: [1] })
  })

  it('never covers a pane with no agent on record, or one mid-failover', () => {
    expect(plan([pane(1, { agentPresent: false })], lanesOf(lane()))).toEqual(EMPTY)
    expect(plan([pane(2, { busy: true })], lanesOf(lane()))).toEqual(EMPTY)
  })

  it('never covers a pane whose account is UNKNOWN — the eight-pane fan-out', () => {
    const unknowns = Array.from({ length: 8 }, (_, i) => pane(i + 1, { profile: UNKNOWN_PROFILE }))
    expect(plan(unknowns, lanesOf(lane()))).toEqual(EMPTY)
  })

  it('still covers a NONE pane on the default lane (login discovery renamed it)', () => {
    const p = pane(1, { profile: NO_PROFILE })
    const l = lane({ profileId: 'default' })
    expect(planCappedOffers([p], lanesOf(l), true, () => undefined, NOW).raise.map((r) => r.paneId)).toEqual([1])
  })

  it('a dismissal holds for THAT window, and expires when it rolls', () => {
    const l = lane()
    const declined = pane(1, { dismissedFor: laneIdentity(l) })
    expect(plan([declined], lanesOf(l))).toEqual(EMPTY)
    expect(plan([declined], lanesOf(lane({ resetsAt: LATER }))).raise.map((r) => r.paneId)).toEqual([1])
  })

  it('a pane on a different provider is never claimed', () => {
    expect(plan([pane(1, { provider: 'codex' })], lanesOf(lane()))).toEqual(EMPTY)
  })
})

// ── Lowering needs the same rigour as raising. A card that flickers off and
// back on is worse than one that lingers a poll, and a single provider glitch
// must not do it. (CodexBar reaches the same rule from the other side: it will
// not clear a depleted state on one positive sample while the trusted boundary
// is still ahead, and waits for a second observation to confirm.)
describe('planCappedOffers — when a held offer may be LOWERED', () => {
  it('ONE unjustified sample does not lower it; it is held and counted', () => {
    const p = plan([holding(1)], new Map())
    expect(p.lower).toEqual([])
    expect(p.holdAmbiguous).toEqual([1])
  })

  it('...and the SECOND one does', () => {
    const p = plan([holding(1, lane(), { missStreak: 1 })], new Map())
    expect(p.lower).toEqual([1])
    expect(p.holdAmbiguous).toEqual([])
  })

  it('the window we NAMED ending lowers it immediately — no confirmation needed', () => {
    // Definitive: whatever the provider says now, the limit on the card is over.
    const past = Date.parse(RESETS) + 1_000
    expect(plan([holding(1)], new Map(), past).lower).toEqual([1])
  })

  it('a genuine ROLLOVER lowers immediately, then re-raises for the new window', () => {
    const rolled = lane({ resetsAt: LATER })
    const p = plan([holding(1)], lanesOf(rolled))
    expect(p.lower).toEqual([1])
    expect(p.holdAmbiguous).toEqual([])
  })

  it('boundary CHURN inside the tolerance is not a rollover — it is held', () => {
    // Anthropic recomputes resets_at per request; two samples of one window
    // differ by seconds. Treating that as a new fact would flicker the card.
    const churned = lane({ resetsAt: new Date(Date.parse(RESETS) + 30_000).toISOString() })
    const p = plan([holding(1)], lanesOf(churned))
    expect(p.lower).toEqual([])
    expect(p.holdAmbiguous).toEqual([1])
  })

  it('with no boundary to trust, confirmation alone decides', () => {
    const boundless = lane({ resetsAt: undefined })
    expect(plan([holding(1, boundless)], new Map()).holdAmbiguous).toEqual([1])
    expect(plan([holding(1, boundless, { missStreak: 1 })], new Map()).lower).toEqual([1])
  })

  it('a glitched sample followed by a recovery never lowers at all', () => {
    // The whole point: one bad reading, then the truth again.
    const glitch = plan([holding(1)], new Map())
    expect(glitch.lower).toEqual([])
    // The reconciler counted the miss; the next tick sees the lane back.
    const recovered = plan([holding(1, lane(), { missStreak: 1 })], lanesOf(lane()))
    expect(recovered).toEqual(EMPTY)
  })
})

describe('cappedOfferCopy', () => {
  it('names the window that is actually spent', () => {
    const { title } = cappedOfferCopy('cdev', 'cmain', lane())
    expect(title).toBe('cdev hit its Weekly limit')
  })

  it('carries the reset line when the provider gave one', () => {
    const { message } = cappedOfferCopy('cdev', 'cmain', lane({ resetText: 'resets in 2h 14m' }))
    expect(message).toBe('Weekly resets in 2h 14m. This session continues under cmain — same pane, same conversation.')
  })

  it('without a lane it stays unqualified rather than inventing a window', () => {
    const copy = cappedOfferCopy('cdev', 'cmain')
    expect(copy.title).toBe('cdev hit its usage limit')
    expect(copy.message).toBeUndefined()
  })
})
