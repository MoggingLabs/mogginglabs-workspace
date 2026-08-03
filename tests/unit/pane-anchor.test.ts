import { describe, expect, it } from 'vitest'
import { classifyAnchorKey } from '@ui/features/terminal/pane-anchor'

// THE BARE-SHIFT SCROLL YANK, pinned.
//
// A pane follows its newest output unless the USER chose otherwise, and the anchor decided
// which keys count as choosing. Its rule was: a scroll chord is a gesture, everything
// unmodified is TYPING — and typing means the user is talking to the prompt, so re-pin to
// the bottom.
//
// A real Shift+PageUp is TWO keydowns. The keyboard sends `Shift` on its own first (already
// carrying shiftKey: true), then `PageUp`. That first event matched no scroll chord and
// fell straight into the typing branch. So from a scrolled-up viewport every attempt to
// page further up slammed back to the prompt first: keyboard scrollback could not get past
// one page, and shift-click selection in history broke the same way.
//
// The gate never saw it because PANESCROLL synthesises composed events —
// `{ key: 'PageUp', shiftKey: true }` — and never sends the modifier keydown a real
// keyboard sends. That is why this classifier is pure and exported: the taxonomy is the
// thing that was wrong, so the taxonomy is what gets tested.

const key = (k: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}) =>
  classifyAnchorKey({ key: k, ...mods })

describe('classifyAnchorKey', () => {
  it('ignores a modifier being HELD — it is not a keystroke', () => {
    // Every one of these arrives on its own before the chord it belongs to.
    expect(key('Shift', { shiftKey: true })).toBe('ignore')
    expect(key('Control', { ctrlKey: true })).toBe('ignore')
    expect(key('Alt', { altKey: true })).toBe('ignore')
    expect(key('Meta', { metaKey: true })).toBe('ignore')
    expect(key('CapsLock')).toBe('ignore')
    expect(key('NumLock')).toBe('ignore')
    expect(key('ScrollLock')).toBe('ignore')
  })

  it('reads the scroll chords as deliberate viewport moves', () => {
    expect(key('PageUp', { shiftKey: true })).toBe('gesture-up')
    expect(key('Home', { shiftKey: true })).toBe('gesture-up')
    expect(key('ArrowUp', { shiftKey: true })).toBe('gesture-up')
    expect(key('PageDown', { shiftKey: true })).toBe('gesture-down')
    expect(key('End', { shiftKey: true })).toBe('gesture-down')
    expect(key('ArrowDown', { shiftKey: true })).toBe('gesture-down')
  })

  it('reads Alt+Arrow — the block-jump chord — as a gesture, not typing', () => {
    // terminal-pane binds these to jump between command blocks. Classified as typing, the
    // anchor re-pinned to the bottom on the next frame and the jump was visibly undone.
    expect(key('ArrowUp', { altKey: true })).toBe('gesture-up')
    expect(key('ArrowDown', { altKey: true })).toBe('gesture-down')
  })

  it('reads ordinary keys as typing at the prompt', () => {
    for (const k of ['a', 'Z', '1', ' ', 'Enter', 'Backspace', 'Tab', 'Escape', 'F5']) {
      expect(key(k), k).toBe('typing')
    }
  })

  it('does not treat a shortcut as typing', () => {
    // Ctrl+C, Cmd+K and friends are not the user talking to the prompt.
    expect(key('c', { ctrlKey: true })).toBe('ignore')
    expect(key('k', { metaKey: true })).toBe('ignore')
    expect(key('t', { altKey: true })).toBe('ignore')
  })

  it('still reads a shifted CHARACTER as typing', () => {
    // Shift is held for capitals; only the modifier's own keydown is ignored.
    expect(key('A', { shiftKey: true })).toBe('typing')
    expect(key('!', { shiftKey: true })).toBe('typing')
  })
})
