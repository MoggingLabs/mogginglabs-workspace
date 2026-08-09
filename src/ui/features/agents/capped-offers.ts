import { RESET_BOUNDARY_TOLERANCE_MS } from '@contracts'
import { paneMatchesCappedLane } from './profile-match'
import type { PaneProfile } from '../../core/agents/pane-profile'
import type { CappedLane } from '../../core/usage/lane-capped'

// Which panes should be covered by a usage-limit offer, which should be
// UNcovered, and what the card says. Pure, so the central negative — "eight live
// panes and no evidence touches nothing" — is one assertion instead of a smoke.

/**
 * The exact fact an offer was raised about. A new window boundary is a NEW fact:
 * the same lane after a rollover is a different claim, which is what lets a
 * dismissal expire by itself instead of needing a timer.
 */
export const laneIdentity = (l: CappedLane): string =>
  `${l.providerId}|${l.profileId}|${l.windowLabel}|${l.resetsAt ?? 'static'}`

export interface CappedPane {
  paneId: number
  provider: string
  profile: PaneProfile
  /** An agent of this pane's provider is on record RIGHT NOW (presence, never
   *  the absence of a verdict). */
  agentPresent: boolean
  /** Mid-failover: another flow owns this pane, so this path must not touch it. */
  busy: boolean
  /** The offer port currently holds the EXACT object this path raised. */
  holdsOurOffer: boolean
  /** The lane identity our held offer was raised for. */
  raisedFor?: string
  /** The boundary of the window our held offer was raised about. While that
   *  instant is still ahead of us it is AUTHORITATIVE: a lane that stops
   *  reading spent before its own window ends is a claim we did not expect. */
  raisedResetsAt?: string
  /** How many consecutive reconciles have already failed to justify the held
   *  offer. Two ambiguous samples confirm; one does not. */
  missStreak?: number
  /** The lane identity the human said "Not now" to. */
  dismissedFor?: string
}

export interface CappedOfferPlan {
  raise: { paneId: number; lane: CappedLane }[]
  /** Panes whose OUR-offer is no longer justified: lower it. */
  lower: number[]
  /** Drop the mark without touching the port — someone else owns the overlay now. */
  forget: number[]
  /** Held despite an unjustified sample, because one sample is not enough to
   *  take a card down. Count these; the next one lowers. */
  holdAmbiguous: number[]
}

const EMPTY_PLAN: CappedOfferPlan = { raise: [], lower: [], forget: [], holdAmbiguous: [] }

/**
 * May we take this card down on THIS sample?
 *
 * Raising needs positive current evidence; lowering needs the same rigour in
 * the other direction, because a card that flickers off and back on is worse
 * than one that lingers a poll. One provider glitch — a single `fresh` sample
 * reading 40% for a lane that is genuinely spent — should not do it.
 *
 * Three things are trustworthy, and nothing else is:
 *
 *  1. The window we raised the card ABOUT has ended. Definitive: whatever the
 *     provider says now, the limit we named is over.
 *  2. The lane is still spent but its boundary genuinely ADVANCED past the one
 *     we raised for (beyond the churn tolerance) — a real rollover, so this is
 *     a new fact and the card should come down and go back up for the new one.
 *  3. We have already seen one unjustified sample. Two agree; one is a rumour.
 *
 * (This is the shape CodexBar arrived at from the other side: it refuses to
 * clear a depleted state on one positive sample while the trusted boundary is
 * still ahead, and waits for a second observation to confirm.)
 */
function trustsLowering(pane: CappedPane, lane: CappedLane | undefined, now: number): boolean {
  const raisedAt = pane.raisedResetsAt ? Date.parse(pane.raisedResetsAt) : Number.NaN
  // No boundary to trust — the lane never published one — so fall back to
  // confirmation alone rather than inventing authority we do not have.
  if (!Number.isFinite(raisedAt)) return (pane.missStreak ?? 0) >= 1
  if (raisedAt <= now) return true // (1) the window we named is over
  if (lane?.resetsAt) {
    const seen = Date.parse(lane.resetsAt)
    if (Number.isFinite(seen) && seen - raisedAt > RESET_BOUNDARY_TOLERANCE_MS) return true // (2) real rollover
  }
  return (pane.missStreak ?? 0) >= 1 // (3) confirmed by a second sample
}

/**
 * `laneKnown === false` returns the empty plan wholesale — it neither raises nor
 * lowers. Not "treat as not capped": DECLINE TO ACT. An input-blocking overlay
 * requires positive, current evidence, and the absence of evidence is never
 * evidence. (At renderer mount the outbox drains milliseconds in, while the first
 * usage poll is still ~1.5s out; that window is exactly when the shipped bug
 * fired. The cost of doing nothing here is a toast the user can flick away; the
 * cost of guessing was eight panes nobody could type into.)
 */
export function planCappedOffers(
  panes: readonly CappedPane[],
  lanes: ReadonlyMap<string, CappedLane>,
  laneKnown: boolean,
  orderZeroFor: (providerId: string) => string | undefined,
  now: number = Date.now()
): CappedOfferPlan {
  if (!laneKnown) return EMPTY_PLAN
  const plan: CappedOfferPlan = { raise: [], lower: [], forget: [], holdAmbiguous: [] }
  const all = [...lanes.values()]
  for (const pane of panes) {
    const lane = all.find((l) =>
      paneMatchesCappedLane({ provider: pane.provider, profile: pane.profile }, l, orderZeroFor(l.providerId))
    )
    if (pane.holdsOurOffer) {
      // Ours to lower — but only while it is still ours and still justified.
      if (!pane.agentPresent) {
        plan.forget.push(pane.paneId)
      } else if (lane && laneIdentity(lane) === pane.raisedFor) {
        // Exactly what we raised it for. Nothing to do.
      } else if (trustsLowering(pane, lane, now)) {
        plan.lower.push(pane.paneId)
      } else {
        plan.holdAmbiguous.push(pane.paneId)
      }
      continue
    }
    if (!pane.agentPresent || pane.busy || !lane) continue
    // The dismissal latch. Going level-triggered without it would re-raise a
    // card the human just declined on the very next poll — a regression the old
    // edge-triggered code avoided by accident. It expires on its own, because a
    // rolled window is a different identity.
    if (pane.dismissedFor === laneIdentity(lane)) continue
    plan.raise.push({ paneId: pane.paneId, lane })
  }
  return plan
}

/** The card's words. `lane` absent = the per-pane notify path, which knows a
 *  limit was hit but not which window — it keeps the original unqualified copy
 *  rather than inventing a window name. */
export function cappedOfferCopy(
  currentName: string,
  nextName: string,
  lane?: CappedLane
): { title: string; message?: string } {
  if (!lane) return { title: `${currentName} hit its usage limit` }
  const tail = `This session continues under ${nextName} — same pane, same conversation.`
  return {
    // Names the window it is actually talking about. Without this a WEEKLY lane
    // at 100% read as a bare "hit its usage limit" while the 5-hour window the
    // user then went and checked was completely untouched.
    title: `${currentName} hit its ${lane.windowLabel} limit`,
    message: lane.resetText ? `${lane.windowLabel} ${lane.resetText}. ${tail}` : tail
  }
}
