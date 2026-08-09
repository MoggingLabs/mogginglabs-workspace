import type { PaneProfile } from '../../core/agents/pane-profile'

/**
 * Does a pane's launch context run the usage lane that just capped? Pure — the
 * fuzziest equality in the failover path, kept in one testable place.
 *
 * The fuzzy arm exists for a real case, and ONLY that case: a pane launched
 * when the provider had NO profiles carries `none`, while the usage seam labels
 * that same lane `'default'` — and login auto-discovery can mint a
 * `login-<provider>` profile MINUTES after that launch, renaming the lane under
 * a pane that is still running. So for a `none` pane, the order-0 id counts as
 * its lane too.
 *
 * What the arm must NOT cover is a pane whose profile is merely UNRECORDED.
 * Those two used to be the same value (`profileId: undefined`), and that is how
 * a single capped-lane event claimed every pane in the grid after a restart:
 * each restored pane had been re-derived as order-0 or left undefined, and
 * either spelling matched. `unknown` now matches nothing. A pane we cannot
 * identify is a pane we leave alone — the usage feature's own toast still names
 * the lane that actually capped.
 */
export function paneMatchesCappedLane(
  pane: { provider: string; profile: PaneProfile },
  capped: { providerId: string; profileId: string },
  orderZeroId: string | undefined
): boolean {
  if (pane.provider !== capped.providerId) return false
  switch (pane.profile.kind) {
    case 'named':
      return pane.profile.id === capped.profileId
    case 'none':
      return capped.profileId === 'default' || (orderZeroId !== undefined && capped.profileId === orderZeroId)
    case 'unknown':
      return false
  }
}
