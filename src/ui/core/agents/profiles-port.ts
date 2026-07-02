/**
 * Change signal for provider profiles + remote hosts (Phase-4 polish). The Settings
 * UI announces after any save/remove; the `agents` feature re-publishes its palette
 * entries and failover data live — no app restart. Pure pub/sub, no data here.
 */
const subscribers = new Set<() => void>()

export function announceProfilesChanged(): void {
  for (const cb of subscribers) cb()
}

export function onProfilesChanged(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
