// The usage-history ring (Phase-7/07): the poller appends each GOOD usedPct
// sample per (provider, window) to a bounded ring in the settings KV. This is
// OUR OWN sampled data — integers 0–100, counts not content (ADR 0005 safe) —
// so EVERY provider gets a sparkline for free, no per-provider history
// endpoint, no extra network. Bounded forever: the ring truncates at
// HISTORY_MAX and a corrupt KV value degrades to an empty series.

export interface HistoryKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** Ring capacity per (provider, window) — 8h of 5-minute samples. */
export const HISTORY_MAX = 96

/** Window labels become stable key slugs ('Session (5h)' -> 'session-5h'). */
const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const ringKey = (providerId: string, windowLabel: string): string => `usage.hist.${providerId}.${slug(windowLabel)}`

/** The stored series, oldest first. Never throws; junk reads as empty. */
export function readHistory(kv: HistoryKv, providerId: string, windowLabel: string): number[] {
  const raw = kv.get(ringKey(providerId, windowLabel))
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []
  } catch {
    return []
  }
}

/** Append one sample (clamped, rounded) and truncate to the last HISTORY_MAX. */
export function appendHistory(kv: HistoryKv, providerId: string, windowLabel: string, usedPct: number): void {
  const ring = readHistory(kv, providerId, windowLabel)
  ring.push(Math.max(0, Math.min(100, Math.round(usedPct))))
  if (ring.length > HISTORY_MAX) ring.splice(0, ring.length - HISTORY_MAX)
  kv.set(ringKey(providerId, windowLabel), JSON.stringify(ring))
}
