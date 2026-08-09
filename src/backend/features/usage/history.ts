// The usage-history ring (Phase-7/07): the poller appends each GOOD usedPct
// sample per (provider, window) to a bounded ring in the settings KV. This is
// OUR OWN sampled data — integers 0–100, counts not content (ADR 0005 safe) —
// so EVERY provider gets a sparkline for free, no per-provider history
// endpoint, no extra network. Bounded forever: the ring truncates at
// HISTORY_MAX and a corrupt KV value degrades to an empty series.

import { slugLabel } from './lane-key'

export interface HistoryKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** Ring capacity per (provider, window) — 8h of 5-minute samples. */
export const HISTORY_MAX = 96

/** One ring per LANE. The 7/09 fan-out reads every profile of a provider, and
 *  folding those into one (provider, window) ring interleaved them — work at 90%
 *  and personal at 10% sampled a 90/10/90/10 sawtooth that is no one's usage,
 *  at half the depth. `default` (the seam's id when NO profile targets the
 *  provider) keeps the historical 2-part key, so single-profile rings carry on.
 *
 *  `lane` is the lane's stable IDENTITY (`laneKey`), not its label — a renamed
 *  window keeps its sparkline. Both spellings slug without colliding
 *  ('five_hour' -> 'five-hour', 'Session (5h)' -> 'session-5h'), which is what
 *  lets the legacy ring be adopted below rather than guessed at. */
const ringKey = (providerId: string, lane: string, profileId?: string): string =>
  profileId && profileId !== 'default'
    ? `usage.hist.${providerId}.${profileId}.${slugLabel(lane)}`
    : `usage.hist.${providerId}.${slugLabel(lane)}`

/** The stored series, oldest first. Never throws; junk reads as empty. */
export function readHistory(kv: HistoryKv, providerId: string, lane: string, profileId?: string): number[] {
  const raw = kv.get(ringKey(providerId, lane, profileId))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []
  } catch {
    return []
  }
}

/** Append one sample (clamped, rounded) and truncate to the last HISTORY_MAX.
 *  `legacyLabel` adopts the pre-id ring ONCE, so a lane's sparkline does not
 *  restart on the update that gave it an id. Cosmetic — unlike the threshold
 *  latch, a lost ring loses a picture, not a single-fire guarantee. */
export function appendHistory(
  kv: HistoryKv,
  providerId: string,
  lane: string,
  usedPct: number,
  profileId?: string,
  legacyLabel?: string
): void {
  let ring = readHistory(kv, providerId, lane, profileId)
  if (!ring.length && legacyLabel && slugLabel(legacyLabel) !== slugLabel(lane)) {
    ring = readHistory(kv, providerId, legacyLabel, profileId)
  }
  ring.push(Math.max(0, Math.min(100, Math.round(usedPct))))
  if (ring.length > HISTORY_MAX) ring.splice(0, ring.length - HISTORY_MAX)
  kv.set(ringKey(providerId, lane, profileId), JSON.stringify(ring))
}
