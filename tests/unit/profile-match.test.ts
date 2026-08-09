import { describe, expect, it } from 'vitest'
import { paneMatchesCappedLane } from '@ui/features/agents/profile-match'
import { NO_PROFILE, UNKNOWN_PROFILE, namedProfile } from '@ui/core/agents/pane-profile'

// The fuzziest equality in the failover path: the pane side and the usage side name
// "no profile chosen" differently ('none' vs 'default'), and login discovery can
// rename the lane under a running pane. A miss here silently downgrades the pane
// overlay to the toast; a false hit raises an offer on the wrong pane — eight of
// them, as it turned out.
describe('paneMatchesCappedLane', () => {
  const capped = (profileId: string, providerId = 'claude'): { providerId: string; profileId: string } => ({
    providerId,
    profileId
  })

  it('matches an exact (provider, profile) pair', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profile: namedProfile('p-a') }, capped('p-a'), 'p-a')).toBe(true)
  })

  it('rejects a different profile or provider', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profile: namedProfile('p-a') }, capped('p-b'), 'p-a')).toBe(false)
    expect(paneMatchesCappedLane({ provider: 'codex', profile: namedProfile('p-a') }, capped('p-a'), 'p-a')).toBe(false)
  })

  it("a pane on a provider with NO profiles owns the 'default' lane", () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profile: NO_PROFILE }, capped('default'), undefined)).toBe(true)
  })

  it('...and owns the order-0 lane too (login discovery renamed it mid-flight)', () => {
    // The arm this fuzz exists for, preserved exactly: a pane launched when the
    // provider had no profiles, and minutes later discovery mints `login-claude`.
    expect(paneMatchesCappedLane({ provider: 'claude', profile: NO_PROFILE }, capped('login-claude'), 'login-claude')).toBe(true)
    expect(paneMatchesCappedLane({ provider: 'claude', profile: NO_PROFILE }, capped('login-claude'), 'p-other')).toBe(false)
  })

  it('a pane WITH a profile never claims the default lane', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profile: namedProfile('p-a') }, capped('default'), 'p-a')).toBe(false)
  })

  // ── THE FAN-OUT THAT COVERED EIGHT PANES.
  //
  // `unknown` and `none` used to be one value (`profileId: undefined`), and the
  // fuzzy arm above answered for both. After a restart every pane's profile was
  // unrecorded, so every pane took that arm and one capped lane claimed the grid.
  // A pane we cannot identify must match NOTHING — swept over the full cross
  // product rather than one representative input, because a single sample cannot
  // tell "returns false" from "returns false for this one case".
  it('an UNKNOWN profile never matches any lane, under any order-zero', () => {
    const cappedIds = ['default', 'p-a', 'login-claude', '']
    const orderZeros = [undefined, 'p-a', 'login-claude']
    const results: boolean[] = []
    for (const id of cappedIds) {
      for (const zero of orderZeros) {
        results.push(paneMatchesCappedLane({ provider: 'claude', profile: UNKNOWN_PROFILE }, capped(id), zero))
      }
    }
    expect(results).toHaveLength(cappedIds.length * orderZeros.length)
    expect(results.every((r) => r === false)).toBe(true)
  })

  it('an UNKNOWN pane does not match even when the capped lane IS the only profile', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profile: UNKNOWN_PROFILE }, capped('p-only'), 'p-only')).toBe(false)
  })
})
