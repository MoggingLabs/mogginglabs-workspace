/**
 * Does a pane's launch context run the usage lane that just capped? Pure — the
 * fuzziest equality in the failover path, kept in one testable place.
 *
 * The wrinkle: the two sides name "no profile chosen" differently. A pane launched
 * when the provider had NO profiles carries `profileId: undefined` (launch resolves
 * order-0 when profiles exist, so undefined really means none existed); the usage
 * seam labels that same lane `'default'`. And login auto-discovery can mint a
 * `login-<provider>` profile MINUTES after that launch — the lane is renamed under
 * the running pane, so the order-0 id must count as the undefined pane's lane too.
 */
export function paneMatchesCappedLane(
  pane: { provider: string; profileId?: string },
  capped: { providerId: string; profileId: string },
  orderZeroId: string | undefined
): boolean {
  if (pane.provider !== capped.providerId) return false
  if (pane.profileId !== undefined) return pane.profileId === capped.profileId
  return capped.profileId === 'default' || (orderZeroId !== undefined && capped.profileId === orderZeroId)
}
