import { describe, expect, it } from 'vitest'
import { endRetiresLaunchContext, pickFailoverTarget } from '@ui/features/agents/launch-ledger'
import { NO_PROFILE, UNKNOWN_PROFILE, namedProfile } from '@ui/core/agents/pane-profile'
import { endProvesAgentGone } from '@ui/features/agents/interrupt-core'
import type { AgentSessionEnd } from '@ui/core/agents/agent-session-port'
import type { AgentProfile } from '@contracts'

const p = (id: string, order: number, provider = 'claude'): AgentProfile => ({ id, name: id, provider, env: {}, order })

describe('endRetiresLaunchContext', () => {
  it('the SHELL dying retires the pane’s launch context', () => {
    expect(endRetiresLaunchContext('pane-gone')).toBe(true)
    expect(endRetiresLaunchContext('exited')).toBe(true)
  })

  it('the retiring set is EXACTLY those two — a new end reason must decide, not default', () => {
    const all: AgentSessionEnd[] = ['exited', 'verdict', 'pane-gone', 'prompt-guess']
    expect(all.filter(endRetiresLaunchContext).sort()).toEqual(['exited', 'pane-gone'])
  })

  it('differs from endProvesAgentGone on exactly `verdict` — and that difference is the point', () => {
    // A profile's env pointers are `export`ed into the pane's SHELL, and the
    // failover relaunch types into that shell. An agent dying inside a living
    // shell is precisely the case the relaunch depends on, so `verdict` proves
    // the agent is gone but must NOT throw away what it was running under.
    expect(endProvesAgentGone('verdict')).toBe(true)
    expect(endRetiresLaunchContext('verdict')).toBe(false)
  })
})

describe('pickFailoverTarget', () => {
  const three = [p('cdev', 0), p('cmain', 1), p('cthird', 2)]

  it('moves to the next profile by order, and wraps', () => {
    const mid = pickFailoverTarget(namedProfile('cmain'), three)
    expect(mid).toEqual({ kind: 'switch', current: three[1], next: three[2] })
    const last = pickFailoverTarget(namedProfile('cthird'), three)
    expect(last).toEqual({ kind: 'switch', current: three[2], next: three[0] })
  })

  it('fewer than two profiles is answered FIRST, whatever we know about this pane', () => {
    for (const prof of [namedProfile('cdev'), NO_PROFILE, UNKNOWN_PROFILE]) {
      expect(pickFailoverTarget(prof, [p('cdev', 0)])).toEqual({ kind: 'too-few' })
      expect(pickFailoverTarget(prof, [])).toEqual({ kind: 'too-few' })
    }
  })

  // ── THE LITERAL BUG. This was `Math.max(0, findIndex(...))`: an unresolvable
  // profile became index 0, and the card then read "cdev hit its usage limit /
  // Continue on cmain". Those two names were the arithmetic of a clamp — nothing
  // had checked that the pane was on cdev, or that cmain was anywhere to go.
  it('an UNKNOWN pane is unidentified — and the pick names NO profile at all', () => {
    const pick = pickFailoverTarget(UNKNOWN_PROFILE, three)
    expect(pick).toEqual({ kind: 'unidentified' })
    const serialized = JSON.stringify(pick)
    expect(serialized).not.toContain('cdev')
    expect(serialized).not.toContain('cmain')
  })

  it('a NONE pane is unidentified too — there is no id to move away from', () => {
    expect(pickFailoverTarget(NO_PROFILE, three)).toEqual({ kind: 'unidentified' })
  })

  it('a named profile that is no longer in the lineup is unidentified, NOT index 0', () => {
    const pick = pickFailoverTarget(namedProfile('p-deleted'), three)
    expect(pick).toEqual({ kind: 'unidentified' })
    expect(JSON.stringify(pick)).not.toContain('cdev')
  })

  it('every non-switch answer is name-free — swept, so no branch can leak one', () => {
    const inputs = [UNKNOWN_PROFILE, NO_PROFILE, namedProfile('p-deleted'), namedProfile('')]
    for (const prof of inputs) {
      const pick = pickFailoverTarget(prof, three)
      expect(pick.kind).toBe('unidentified')
      expect(JSON.stringify(pick)).toBe('{"kind":"unidentified"}')
    }
  })
})
