import { describe, expect, it } from 'vitest'
import { pastTrustDialog, trustDialogLive } from '@ui/features/agents/auto-trust'

// The auto-trust matcher (product decision 2026-08-02: an app-launched claude in the
// workspace's own folder gets its trust dialog answered — opening the workspace there
// IS the declaration). A wrong match types Enter into a live conversation; a missed
// one strands the one-click switch on a dialog the blur is hiding.
describe('trustDialogLive', () => {
  const DIALOG = [
    'Quick safety check: Is this a project you created or one you trust?',
    "Claude Code'll be able to read, edit, and execute files here.",
    ') 1. Yes, I trust this folder',
    '  2. No, exit',
    'Enter to confirm · Esc to cancel'
  ].join('\n')

  it('matches the live dialog (question + confirm hint together)', () => {
    expect(trustDialogLive(DIALOG)).toBe(true)
  })

  it('a scrollback fragment without the confirm hint is spent, not live', () => {
    expect(trustDialogLive('…trust this folder\nPS C:\\repo>')).toBe(false)
  })

  it('a confirm hint from some OTHER dialog does not read as trust', () => {
    expect(trustDialogLive('Choose a model\nEnter to confirm · Esc to cancel')).toBe(false)
  })

  it('empty and null tails say nothing', () => {
    expect(trustDialogLive('')).toBe(false)
    expect(trustDialogLive(null)).toBe(false)
  })
})

describe('pastTrustDialog', () => {
  it('recognizes the welcome box and a live prompt as past the gate', () => {
    expect(pastTrustDialog('Welcome back VoxHorizon!')).toBe(true)
    expect(pastTrustDialog('? for shortcuts')).toBe(true)
    expect(pastTrustDialog('esc to interrupt')).toBe(true)
  })

  it('does not claim past-the-gate on the dialog itself', () => {
    expect(pastTrustDialog('1. Yes, I trust this folder\nEnter to confirm')).toBe(false)
  })
})
