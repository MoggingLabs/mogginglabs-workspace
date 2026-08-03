import { describe, expect, it } from 'vitest'
import { describeAsyncError } from '@ui/core/async/async-state'

// WHAT THE USER IS TOLD WHEN AN IPC CALL FAILS.
//
// Ten features route their failures through this one function, so a regression here does not
// break a feature — it degrades every error message in the app at once, in the direction of
// pasting machine noise at someone.
//
// Three things have to happen: strip Electron's wrapper so the real message survives; refuse a
// message that is only the transport describing itself; and refuse a paragraph.

describe('describeAsyncError', () => {
  it('keeps a real, short message', () => {
    expect(describeAsyncError(new Error('Disk is full'), 'save')).toBe('Disk is full')
  })

  // Electron wraps every rejection from ipcMain.handle. Unstripped, the user sees the channel
  // name and two `Error:` prefixes before the sentence that actually matters.
  it('strips the Electron IPC wrapper', () => {
    const wrapped = new Error("Error invoking remote method 'workspace:save': Error: Disk is full")
    expect(describeAsyncError(wrapped, 'save')).toBe('Disk is full')
  })

  it('takes the first line — a stack is not a message', () => {
    expect(describeAsyncError(new Error('Disk is full\n    at foo (bar.ts:1:1)'), 'save')).toBe('Disk is full')
  })

  it('accepts a bare string as well as an Error', () => {
    expect(describeAsyncError('Disk is full', 'save')).toBe('Disk is full')
  })

  // The transport describing itself is never a sentence a person can act on.
  it('refuses transport noise and says the honest generic thing', () => {
    for (const noise of [
      'reply was never sent',
      'No handler registered for workspace:save',
      'An object could not be cloned.',
      'Object has been destroyed',
      'Render frame was disposed before WebFrameMain could be accessed'
    ]) {
      expect(describeAsyncError(new Error(noise), 'save'), noise).toBe('Could not save. Try again.')
    }
  })

  it('matches transport noise case-insensitively', () => {
    expect(describeAsyncError(new Error('REPLY WAS NEVER SENT'), 'save')).toBe('Could not save. Try again.')
  })

  it('refuses a paragraph', () => {
    expect(describeAsyncError(new Error('x'.repeat(141)), 'save')).toBe('Could not save. Try again.')
  })

  it('keeps a message right at the length limit', () => {
    const at = 'x'.repeat(140)
    expect(describeAsyncError(new Error(at), 'save')).toBe(at)
  })

  it('refuses an empty or whitespace message rather than showing nothing', () => {
    expect(describeAsyncError(new Error(''), 'save')).toBe('Could not save. Try again.')
    expect(describeAsyncError(new Error('   '), 'save')).toBe('Could not save. Try again.')
    expect(describeAsyncError(undefined, 'save')).toBe('Could not save. Try again.')
    expect(describeAsyncError({ nope: true }, 'save')).toBe('Could not save. Try again.')
  })

  it('names the action the user actually attempted', () => {
    expect(describeAsyncError(new Error(''), 'open that folder')).toBe('Could not open that folder. Try again.')
  })

  // A wrapped noise message is the compound case: the wrapper must come off BEFORE the noise
  // test, or the pattern anchors never match and the raw transport text reaches the user.
  it('recognises noise that arrived inside the IPC wrapper', () => {
    const wrapped = new Error("Error invoking remote method 'x': Error: reply was never sent")
    expect(describeAsyncError(wrapped, 'save')).toBe('Could not save. Try again.')
  })
})
