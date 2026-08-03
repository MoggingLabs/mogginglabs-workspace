/**
 * A usage lane hit 100% (the engine's `capped` alert level). ANNOUNCER: the `usage`
 * feature, on the alert channel's word. SUBSCRIBER: the `agents` feature, which maps
 * (provider, profile) to the live panes running that lane and raises the pane
 * profile-switch offer. A port so neither imports the other (launch-port pattern).
 *
 * CLAIM semantics, synchronous: the subscriber returns true when at least one live
 * pane matched — the announcer then suppresses its toast (the pane overlay IS the
 * surface). False/no subscriber → the announcer falls back to the toast, so a capped
 * lane with no pane (capped from another machine, nothing launched) is still told.
 * Ids only — never env values or usage numbers (ADR 0002/0005).
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
