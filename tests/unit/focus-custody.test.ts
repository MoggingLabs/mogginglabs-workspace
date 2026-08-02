import { describe, expect, it } from 'vitest'
import { FOCUSABLE_SELECTOR, focusIndexAfterRebuild, isFocusCandidate } from '@ui/core/a11y/focus'

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
