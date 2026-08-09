/**
 * A NUDGE THAT A USAGE LANE MAY BE SPENT — not a fact about one.
 *
 * ANNOUNCER: the `usage` feature, on the alert channel's word. SUBSCRIBER: the
 * `agents` feature, which RE-DERIVES from the current lane snapshot
 * (`usage-lane-port`) and covers the panes that snapshot justifies. A port so
 * neither imports the other (launch-port pattern).
 *
 * WHY A NUDGE. The alert behind this is an EDGE ("the lane just crossed 100")
 * delivered over an at-least-once queue with a replay window, and it used to
 * drive persistent, input-blocking UI directly. So a `capped` alert queued for a
 * 5-hour window replayed on the next launch, and after an update restart it
 * covered every pane in the grid over a window that had long since reset. The
 * subscriber can no longer make that mistake, because this payload carries ids
 * and nothing else — it is structurally incapable of asserting. That narrowness
 * is the guarantee, not a limitation: do not widen it.
 *
 * CLAIM semantics, synchronous and unchanged: the subscriber returns true when
 * its re-derivation now covers at least one pane on THIS lane — the announcer
 * then suppresses its toast (the pane overlay IS the surface). False/no
 * subscriber → the toast, so a capped lane with no pane (capped from another
 * machine, nothing launched) and a lane we cannot yet vouch for are both still
 * told. Ids only — never env values or usage numbers (ADR 0002/0005).
 */
export interface UsageCappedEvent {
  providerId: string
  profileId: string
}

const subscribers = new Set<(ev: UsageCappedEvent) => boolean>()

/** Returns true if any subscriber claimed the event (a pane offer was raised). */
export function announceUsageCapped(ev: UsageCappedEvent): boolean {
  let claimed = false
  for (const cb of subscribers) claimed = cb(ev) || claimed
  return claimed
}

export function onUsageCapped(cb: (ev: UsageCappedEvent) => boolean): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
