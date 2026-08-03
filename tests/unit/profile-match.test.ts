import { describe, expect, it } from 'vitest'
import { paneMatchesCappedLane } from '@ui/features/agents/profile-match'

// The fuzziest equality in the failover path: the pane side and the usage side name
// "no profile chosen" differently ('undefined' vs 'default'), and login discovery
// can rename the lane under a running pane. A miss here silently downgrades the
// pane overlay to the toast; a false hit raises an offer on the wrong pane.
describe('paneMatchesCappedLane', () => {
  const capped = (profileId: string, providerId = 'claude'): { providerId: string; profileId: string } => ({
    providerId,
    profileId
  })

  it('matches an exact (provider, profile) pair', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profileId: 'p-a' }, capped('p-a'), 'p-a')).toBe(true)
  })

  it('rejects a different profile or provider', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profileId: 'p-a' }, capped('p-b'), 'p-a')).toBe(false)
    expect(paneMatchesCappedLane({ provider: 'codex', profileId: 'p-a' }, capped('p-a'), 'p-a')).toBe(false)
  })

  it("a profile-less pane owns the 'default' lane", () => {
    expect(paneMatchesCappedLane({ provider: 'claude' }, capped('default'), undefined)).toBe(true)
  })

  it('a profile-less pane owns the order-0 lane (login discovery renamed it)', () => {
    expect(paneMatchesCappedLane({ provider: 'claude' }, capped('login-claude'), 'login-claude')).toBe(true)
    expect(paneMatchesCappedLane({ provider: 'claude' }, capped('login-claude'), 'p-other')).toBe(false)
  })

  it('a pane WITH a profile never claims the default lane', () => {
    expect(paneMatchesCappedLane({ provider: 'claude', profileId: 'p-a' }, capped('default'), 'p-a')).toBe(false)
  })
})
