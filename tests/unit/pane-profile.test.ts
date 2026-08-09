import { describe, expect, it } from 'vitest'
import {
  NO_PROFILE,
  UNKNOWN_PROFILE,
  fromPersistedSlot,
  namedProfile,
  orderZeroProfileId,
  profileIdOf,
  profilesFor,
  resolveAdoptedProfile,
  resolveLaunchProfile,
  toPersistedSlot
} from '@ui/core/agents/pane-profile'
import type { AgentProfile } from '@contracts'

// The tri-state that replaced `profileId?: string`. `undefined` used to mean both
// "the provider has no profiles" and "nobody recorded one", and four call sites
// resolved the ambiguity by defaulting to order-0 — which is how one capped lane
// covered eight panes with a card naming an account none of them had to be on.

const p = (id: string, order: number, provider = 'claude'): AgentProfile => ({ id, name: id, provider, env: {}, order })

describe('profilesFor / orderZeroProfileId', () => {
  it('sorts by ORDER, not array position', () => {
    // Shuffled on purpose: array order must never be able to pass by accident.
    const all = [p('c', 2), p('a', 0), p('b', 1)]
    expect(profilesFor(all, 'claude').map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(orderZeroProfileId(all, 'claude')).toBe('a')
  })

  it('never leaks another provider’s rows', () => {
    const all = [p('cx', 0, 'codex'), p('a', 1)]
    expect(profilesFor(all, 'claude').map((x) => x.id)).toEqual(['a'])
    expect(orderZeroProfileId(all, 'claude')).toBe('a')
    expect(orderZeroProfileId(all, 'gemini')).toBeUndefined()
  })
})

describe('resolveLaunchProfile — a launch is about to CHOOSE, so it always knows', () => {
  it('a named request wins over order-0', () => {
    expect(resolveLaunchProfile('p-b', [p('p-a', 0), p('p-b', 1)])).toEqual(namedProfile('p-b'))
  })

  it('an omitted request resolves to order-0, by ORDER', () => {
    expect(resolveLaunchProfile(undefined, [p('c', 2), p('a', 0), p('b', 1)].sort((x, y) => x.order - y.order))).toEqual(
      namedProfile('a')
    )
  })

  it('an omitted request with zero profiles is NONE — a tautology, not a guess', () => {
    expect(resolveLaunchProfile(undefined, [])).toEqual(NO_PROFILE)
  })

  it('a requested id that is no longer in the list is still what main was handed', () => {
    // Recording anything else would make the manifest disagree with the process.
    expect(resolveLaunchProfile('p-deleted', [p('p-a', 0)])).toEqual(namedProfile('p-deleted'))
  })

  it('NEVER returns unknown — swept over the whole input matrix', () => {
    const requests = [undefined, 'p-x', 'p-deleted']
    const lineups = [[], [p('p-a', 0)], [p('p-a', 0), p('p-b', 1), p('p-c', 2)]]
    const kinds: string[] = []
    for (const r of requests) for (const mine of lineups) kinds.push(resolveLaunchProfile(r, mine).kind)
    expect(kinds).toHaveLength(9)
    expect(kinds.includes('unknown')).toBe(false)
  })
})

describe('resolveAdoptedProfile — an adopt READS a process it did not start', () => {
  it('a recorded id is a fact, even one not in the current list', () => {
    // A profile deleted while the daemon kept the agent alive: the process still
    // runs under the home that id named.
    expect(resolveAdoptedProfile('p-gone', [p('p-a', 0)])).toEqual(namedProfile('p-gone'))
  })

  it('a blank record with zero profiles is NONE', () => {
    expect(resolveAdoptedProfile(undefined, [])).toEqual(NO_PROFILE)
  })

  it('THE EIGHT-PANES REGRESSION: a blank record is UNKNOWN, never order-0', () => {
    for (const n of [1, 2, 5]) {
      const mine = Array.from({ length: n }, (_, i) => p(`p-${i}`, i))
      const got = resolveAdoptedProfile(undefined, mine)
      expect(got).toEqual(UNKNOWN_PROFILE)
      expect(profileIdOf(got)).toBeUndefined()
      expect(profileIdOf(got)).not.toBe(mine[0].id)
    }
  })
})

describe('profileIdOf is never inverted', () => {
  it('yields an id only for a named profile', () => {
    expect(profileIdOf(namedProfile('p-a'))).toBe('p-a')
    expect(profileIdOf(NO_PROFILE)).toBeUndefined()
    expect(profileIdOf(UNKNOWN_PROFILE)).toBeUndefined()
  })
})

describe('manifest slot encoding', () => {
  it('only a named profile persists an id; the other two persist null', () => {
    expect(toPersistedSlot(namedProfile('p-a'))).toBe('p-a')
    expect(toPersistedSlot(NO_PROFILE)).toBeNull()
    expect(toPersistedSlot(UNKNOWN_PROFILE)).toBeNull()
  })

  it('a blank slot reads back as UNKNOWN — the manifest cannot tell us what nobody wrote', () => {
    for (const v of [null, undefined, '']) expect(fromPersistedSlot(v)).toEqual(UNKNOWN_PROFILE)
    expect(fromPersistedSlot('p-a')).toEqual(namedProfile('p-a'))
  })

  it('round-trips a named profile and only a named profile', () => {
    const kinds = [namedProfile('p-a'), NO_PROFILE, UNKNOWN_PROFILE].map((x) => fromPersistedSlot(toPersistedSlot(x)).kind)
    expect(kinds).toEqual(['named', 'unknown', 'unknown'])
  })
})
