import { describe, expect, it } from 'vitest'
import { FOCUSABLE_SELECTOR, focusIndexAfterRebuild, focusKeyAfterRebuild, isFocusCandidate } from '@ui/core/a11y/focus'

// FOCUS CUSTODY, pinned.
//
// The focus walk is written out in five places and each copy knows slightly different
// rules. Two of them were wrong, and both fail in a way nothing surfaces — the user just
// finds the keyboard stops working.

describe('isFocusCandidate', () => {
  it('accepts the ordinary interactive elements', () => {
    for (const tag of ['a', 'button', 'input', 'select', 'textarea']) {
      expect(isFocusCandidate({ tag }), tag).toBe(true)
    }
  })

  it('rejects a disabled control', () => {
    expect(isFocusCandidate({ tag: 'button', disabled: true })).toBe(false)
  })

  it('rejects a hidden one', () => {
    expect(isFocusCandidate({ tag: 'input', hidden: true })).toBe(false)
  })

  // THE regression. The selector excluded [tabindex="-1"] only on its generic [tabindex]
  // branch, so a <button tabindex="-1"> still matched button:not([disabled]) — and the
  // palette builds exactly that. Its options are tabIndex -1 ON PURPOSE: the input is the
  // one tab stop and the options are reached with the arrows. Counting them as tab stops
  // made Tab walk the list instead of cycling the dialog.
  it('rejects tabIndex -1 whatever the tag', () => {
    for (const tag of ['button', 'a', 'div', 'input']) {
      expect(isFocusCandidate({ tag, tabIndex: -1 }), tag).toBe(false)
    }
  })

  it('accepts a non-interactive element that opts IN with a tabindex', () => {
    expect(isFocusCandidate({ tag: 'div', tabIndex: 0 })).toBe(true)
  })

  it('rejects a plain non-interactive element', () => {
    expect(isFocusCandidate({ tag: 'div' })).toBe(false)
    expect(isFocusCandidate({ tag: 'span' })).toBe(false)
  })

  it('the SELECTOR agrees: every branch excludes tabindex -1', () => {
    // A branch that forgets it is the whole bug, and the selector is what the DOM walk
    // actually uses — so assert the string, not just the predicate beside it.
    for (const branch of FOCUSABLE_SELECTOR.split(',')) {
      expect(branch, branch).toContain(':not([tabindex="-1"])')
    }
  })
})

describe('focusIndexAfterRebuild', () => {
  it('keeps the position when the list is unchanged', () => {
    expect(focusIndexAfterRebuild(3, 10)).toBe(3)
  })

  // The clamp is the part that gets forgotten: a rebuild that produced FEWER rows leaves
  // the remembered index past the end, and focusing element N of an N-length list throws
  // or silently focuses nothing.
  it('clamps when the rebuild shrank the list', () => {
    expect(focusIndexAfterRebuild(9, 3)).toBe(2)
    expect(focusIndexAfterRebuild(1, 1)).toBe(0)
  })

  it('gives up rather than grabbing element 0 of an empty list', () => {
    expect(focusIndexAfterRebuild(4, 0)).toBe(-1)
  })

  it('gives up when nothing was focused before', () => {
    // -1 in means "focus was elsewhere" — restoring would STEAL it.
    expect(focusIndexAfterRebuild(-1, 10)).toBe(-1)
  })
})

describe('focusKeyAfterRebuild', () => {
  // Restoring by POSITION is right for anonymous rows. When rows have identity — provider
  // tiles, palette chips — a rebuild that inserts or removes one moves everything after it,
  // and the caret lands on a different tile than the user was on.
  it('follows the key when it survives, wherever it moved to', () => {
    expect(focusKeyAfterRebuild('claude', 0, ['shell', 'claude', 'codex'])).toBe(1)
    expect(focusKeyAfterRebuild('claude', 2, ['claude', 'codex'])).toBe(0)
  })

  // THE regression the wizard shipped: its private restore keyed on a `data-chip` attribute
  // that the ▾ button never carried, so a missing key meant "give up" — and giving up is how
  // focus reached <body> mid-keyboard-navigation.
  it('falls back to the clamped index when the key is gone', () => {
    expect(focusKeyAfterRebuild('aider', 4, ['shell', 'claude'])).toBe(1)
    expect(focusKeyAfterRebuild('aider', 0, ['shell', 'claude'])).toBe(0)
  })

  it('leaves focus alone when there is nothing to focus', () => {
    expect(focusKeyAfterRebuild('claude', 0, [])).toBe(-1)
    expect(focusKeyAfterRebuild(null, -1, ['a'])).toBe(-1)
  })

  it('restores by index when there was never a key', () => {
    expect(focusKeyAfterRebuild(null, 2, ['a', 'b', 'c', 'd'])).toBe(2)
    expect(focusKeyAfterRebuild(null, 9, ['a', 'b'])).toBe(1)
  })

  it('prefers the key over the index when they disagree', () => {
    // The whole point: the row moved, and position would silently land elsewhere.
    expect(focusKeyAfterRebuild('codex', 0, ['shell', 'claude', 'codex'])).toBe(2)
  })

  it('takes the first occurrence of a repeated key', () => {
    expect(focusKeyAfterRebuild('shell', 3, ['shell', 'shell', 'shell'])).toBe(0)
  })
})
