import { beforeEach, describe, expect, it } from 'vitest'
import { LAUNCH_INTENT_VERSION, type PaneLaunchIntent } from '@contracts'
import { forgetPaneLaunch, paneLaunchFor, rememberPaneLaunch, rememberedProfileFor } from '../../src/main/pane-launch'

// A pane's own record of which profile it ran under. The bug this exists for: the only
// durable record was the workspace manifest's slot entry, written ONLY when a launch NAMED a
// profile. A launch that took the default — and every hand-typed agent — left it null, so a
// restore re-resolved "whichever profile is order 0 right now" and brought the pane back on a
// different config home than the one it had been running under.

const intent = (over: Partial<PaneLaunchIntent> = {}): PaneLaunchIntent => ({
  v: LAUNCH_INTENT_VERSION,
  agentId: 'claude',
  cwd: 'C:\\repos\\alpha',
  profileId: 'cmain',
  configDir: 'C:\\Users\\p\\.claude-cmain',
  source: 'declared',
  at: 1,
  ...over
})

describe('pane launch memory', () => {
  beforeEach(() => {
    for (const id of [1, 2, 3]) forgetPaneLaunch(id)
  })

  it('answers with the profile the pane actually ran under', () => {
    rememberPaneLaunch(1, intent())
    expect(rememberedProfileFor(1, 'claude')).toBe('cmain')
    expect(paneLaunchFor(1)?.configDir).toBe('C:\\Users\\p\\.claude-cmain')
  })

  // A pane that ran claude says nothing about which CODEX profile a codex launch belongs to.
  it('does not answer across providers', () => {
    rememberPaneLaunch(1, intent())
    expect(rememberedProfileFor(1, 'codex')).toBeUndefined()
  })

  it('answers nothing for a pane it never saw, or no pane at all', () => {
    expect(rememberedProfileFor(2, 'claude')).toBeUndefined()
    expect(rememberedProfileFor(undefined, 'claude')).toBeUndefined()
  })

  // Pane ids are REUSED (a split takes the lowest free one). A closed pane's profile must not
  // become the silent default for whatever opens at that id next.
  it('forgets a closed pane so a recycled id inherits nothing', () => {
    rememberPaneLaunch(3, intent())
    forgetPaneLaunch(3)
    expect(rememberedProfileFor(3, 'claude')).toBeUndefined()
  })

  it('clears the record when told the pane has no intent', () => {
    rememberPaneLaunch(1, intent())
    rememberPaneLaunch(1, undefined)
    expect(paneLaunchFor(1)).toBeUndefined()
  })

  // A detected (hand-typed) agent records no profile — the case that used to leave the slot
  // null forever. It must answer "no opinion", not a stale one from a previous launch.
  it('answers nothing when the pane recorded no profile', () => {
    rememberPaneLaunch(1, intent({ source: 'detected', profileId: undefined, configDir: undefined }))
    expect(rememberedProfileFor(1, 'claude')).toBeUndefined()
    expect(paneLaunchFor(1)?.agentId).toBe('claude')
  })
})
