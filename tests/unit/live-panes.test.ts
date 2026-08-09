import { describe, expect, it } from 'vitest'
import {
  describeLive,
  describePaneLive,
  inspectLiveness,
  type PaneLiveness
} from '@ui/features/workspace/live-panes'

// The predicate behind every destructive confirm. Its copy contracts are pinned by smokes
// that cannot run here, so the exact regexes they use are re-asserted below — with their
// line numbers in the test names, so whoever changes one finds the other.

const row = (over: Partial<PaneLiveness> = {}): PaneLiveness => ({
  id: 1,
  hasSession: false,
  working: false,
  foreground: false,
  ...over
})

describe('three kinds of evidence, two spoken reasons', () => {
  it.each([
    [false, false, false, { panes: 0, sessions: 0, running: 0 }],
    [true, false, false, { panes: 1, sessions: 1, running: 0 }],
    [false, true, false, { panes: 1, sessions: 0, running: 1 }],
    [false, false, true, { panes: 1, sessions: 0, running: 1 }],
    [true, true, false, { panes: 1, sessions: 1, running: 1 }],
    [true, false, true, { panes: 1, sessions: 1, running: 1 }],
    [false, true, true, { panes: 1, sessions: 0, running: 1 }],
    [true, true, true, { panes: 1, sessions: 1, running: 1 }]
  ])('session=%s working=%s foreground=%s', (hasSession, working, foreground, want) => {
    const live = inspectLiveness([row({ hasSession, working, foreground })])
    expect(live.panes).toHaveLength(want.panes)
    expect(live.sessions).toHaveLength(want.sessions)
    // working ∪ foreground, counted once: they are the same sentence in English.
    expect(live.running).toHaveLength(want.running)
  })

  it('only (0,0,0) warrants no confirmation at all', () => {
    expect(inspectLiveness([row()]).panes).toEqual([])
    expect(inspectLiveness([]).panes).toEqual([])
    expect(describeLive(inspectLiveness([]))).toBe('')
  })

  it('running is the union, not the sum — a pane counted twice would inflate the dialog', () => {
    const live = inspectLiveness([row({ id: 7, working: true, foreground: true })])
    expect(live.running).toEqual([7])
    expect(describeLive(live)).toBe('1 pane is still running')
  })
})

describe('the copy contracts the smokes pin', () => {
  it('the pure-process branch never says "agent" (wsclose-smoke.ts:85)', () => {
    for (const r of [
      row({ working: true }),
      row({ foreground: true }),
      row({ foreground: true, command: 'vim' }),
      row({ working: true, foreground: true, command: 'npm' })
    ]) {
      const message = describePaneLive(inspectLiveness([r]))
      expect(message, JSON.stringify(r)).toMatch(/still running/i)
      expect(message, JSON.stringify(r)).not.toMatch(/agent/i)
    }
  })

  it('an assigned-but-idle agent never says "still running" (wsclose-smoke.ts:113)', () => {
    const message = describePaneLive(inspectLiveness([row({ hasSession: true })]))
    expect(message).toMatch(/agent session/i)
    expect(message).not.toMatch(/still running/i)
  })

  it('names the command when it is the only thing live', () => {
    expect(describePaneLive(inspectLiveness([row({ foreground: true, command: 'vim' })]))).toBe(
      'This pane is still running vim.'
    )
  })

  it('the session outranks the name', () => {
    // "An agent session … is still running claude" is noise.
    const live = inspectLiveness([row({ hasSession: true, foreground: true, command: 'claude' })])
    expect(live.command).toBeUndefined()
    expect(describePaneLive(live)).toBe('An agent session is assigned to this pane and is still running.')
  })

  it('ambiguity is silence — two live panes name nothing', () => {
    const live = inspectLiveness([
      row({ id: 1, foreground: true, command: 'vim' }),
      row({ id: 2, foreground: true, command: 'node' })
    ])
    expect(live.command).toBeUndefined()
    expect(describeLive(live)).toBe('2 panes are still running')
  })

  it('plurals and the join read as English', () => {
    const live = inspectLiveness([
      row({ id: 1, hasSession: true }),
      row({ id: 2, working: true }),
      row({ id: 3, foreground: true }),
      row({ id: 4, foreground: true })
    ])
    expect(describeLive(live)).toBe('1 pane has an agent session, and 3 panes are still running')
  })
})

describe('a basename from a process table is untrusted input', () => {
  it.each([
    ['too long', 'x'.repeat(33)],
    ['an escape', `vi${String.fromCharCode(0x1b)}m`],
    ['a NUL', `vi${String.fromCharCode(0)}m`],
    ['a DEL', `vim${String.fromCharCode(0x7f)}`],
    ['empty', ''],
    ['whitespace only', '   ']
  ])('refuses %s', (_why, command) => {
    const live = inspectLiveness([row({ foreground: true, command })])
    expect(live.command).toBeUndefined()
    // Still warns — the fact survives; only the name is dropped.
    expect(describePaneLive(live)).toBe('This pane is still running.')
  })

  it('accepts an ordinary basename', () => {
    expect(inspectLiveness([row({ foreground: true, command: 'ping' })]).command).toBe('ping')
  })
})
