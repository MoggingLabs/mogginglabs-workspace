import { describe, expect, it } from 'vitest'
import { hasModKey, matchChord, type ChordEvent } from '@ui/core/commands/chords'

// THE CHORD RULE, pinned — for BOTH platforms, on every runner.
//
// The rule was written out longhand at each listener, so each got a slightly different
// one. The matcher exists so the whole table can be asserted under node: the platform
// divergence below is invisible on whichever platform you happen to be testing, which is
// exactly why it survived.

const ev = (over: Partial<ChordEvent> & { code: string }): ChordEvent => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over
})

describe('hasModKey', () => {
  it('is Ctrl on Windows/Linux and Cmd on macOS — never both', () => {
    expect(hasModKey({ ctrlKey: true, metaKey: false }, 'other')).toBe(true)
    expect(hasModKey({ ctrlKey: false, metaKey: true }, 'other')).toBe(false)
    expect(hasModKey({ ctrlKey: false, metaKey: true }, 'mac')).toBe(true)
    expect(hasModKey({ ctrlKey: true, metaKey: false }, 'mac')).toBe(false)
  })

  // THE regression. On Windows metaKey IS the Windows key, and several of the chords it
  // fired are OS-reserved — Win+K is Cast, so one press opened our palette AND Windows'
  // panel. shortcuts.ts documented the old behaviour as intended, which is how it lasted.
  it('does NOT treat the Windows key as the platform modifier', () => {
    expect(hasModKey({ ctrlKey: false, metaKey: true }, 'other')).toBe(false)
  })
})

describe('matchChord', () => {
  const paletteChord = { code: 'KeyK', mod: true }

  it('matches the platform modifier on each platform', () => {
    expect(matchChord(paletteChord, ev({ code: 'KeyK', ctrlKey: true }), 'other')).toBe(true)
    expect(matchChord(paletteChord, ev({ code: 'KeyK', metaKey: true }), 'mac')).toBe(true)
  })

  it('does not fire on the Windows key', () => {
    expect(matchChord(paletteChord, ev({ code: 'KeyK', metaKey: true }), 'other')).toBe(false)
  })

  it('does not fire on Ctrl on macOS', () => {
    // Ctrl+K is readline's kill-line — a chord the terminal owns.
    expect(matchChord(paletteChord, ev({ code: 'KeyK', ctrlKey: true }), 'mac')).toBe(false)
  })

  it('requires the chord EXACTLY — an unlisted modifier must be up', () => {
    // Without this, Ctrl+K swallows Ctrl+Shift+K and Ctrl+Alt+K too.
    expect(matchChord(paletteChord, ev({ code: 'KeyK', ctrlKey: true, shiftKey: true }), 'other')).toBe(false)
    expect(matchChord(paletteChord, ev({ code: 'KeyK', ctrlKey: true, altKey: true }), 'other')).toBe(false)
    expect(matchChord(paletteChord, ev({ code: 'KeyK', ctrlKey: true, metaKey: true }), 'other')).toBe(false)
  })

  it('matches shifted and alted chords when they are declared', () => {
    const board = { code: 'KeyG', mod: true, shift: true }
    expect(matchChord(board, ev({ code: 'KeyG', ctrlKey: true, shiftKey: true }), 'other')).toBe(true)
    expect(matchChord(board, ev({ code: 'KeyG', ctrlKey: true }), 'other')).toBe(false)
  })

  // The physical-key half. `e.key` is what the LAYOUT produced.
  it('keys off the PHYSICAL key, so a non-QWERTY layout still works', () => {
    // AZERTY: the top-row 1 key produces '&'. A key-based check compares '&' to '1' and
    // never matches, so Ctrl+1 could not switch to workspace 1 on a French keyboard.
    const ws1 = { code: 'Digit1', mod: true }
    expect(matchChord(ws1, ev({ code: 'Digit1', ctrlKey: true }), 'other')).toBe(true)
    // German: Ctrl+= needs AltGr, and `e.key` is not '='. The code is stable.
    const zoom = { code: 'Equal', mod: true }
    expect(matchChord(zoom, ev({ code: 'Equal', ctrlKey: true }), 'other')).toBe(true)
  })

  it('does not match a different physical key', () => {
    expect(matchChord(paletteChord, ev({ code: 'KeyJ', ctrlKey: true }), 'other')).toBe(false)
  })

  it('supports an unmodified chord', () => {
    const esc = { code: 'Escape' }
    expect(matchChord(esc, ev({ code: 'Escape' }), 'other')).toBe(true)
    expect(matchChord(esc, ev({ code: 'Escape', ctrlKey: true }), 'other')).toBe(false)
  })
})
