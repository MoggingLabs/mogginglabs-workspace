// Focus custody rules. PURE — the decisions only; the DOM work stays with the callers.
//
// Focus handling in this app is an idiom rather than a module: the same walk is written
// out in overlay-trap, modal, the folder browser, the file tree and the grid painter, and
// each copy knows a slightly different set of rules. The two decisions that were actually
// wrong are extracted here so they can be asserted.

/** The CSS selector for something a Tab press can reach. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]'
]
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(',')

/** The shape a focus decision reads off a candidate element. */
export interface FocusCandidate {
  tag: string
  disabled?: boolean
  tabIndex?: number
  hidden?: boolean
}

/**
 * Can a Tab press land here?
 *
 * `tabIndex === -1` is the case the selector got wrong. It excluded `[tabindex="-1"]` only
 * on the generic `[tabindex]` branch, so a `<button tabindex="-1">` still matched
 * `button:not([disabled])` — and the palette makes exactly that: its options are
 * tabIndex -1 on purpose, because the input is the ONE tab stop and the options are reached
 * with the arrows. The trap therefore counted every option as a tab stop, so Tab walked
 * through the list instead of cycling the dialog, and the "one tab stop" contract the
 * palette documents was not the behaviour it had.
 */
export function isFocusCandidate(c: FocusCandidate): boolean {
  if (c.hidden) return false
  if (c.disabled) return false
  if (typeof c.tabIndex === 'number' && c.tabIndex < 0) return false
  return ['a', 'button', 'input', 'select', 'textarea'].includes(c.tag.toLowerCase()) || typeof c.tabIndex === 'number'
}

/**
 * Where focus goes after a list rebuilds in place.
 *
 * A surface that rebuilds by clearing its container and re-appending destroys the focused
 * element, and focus falls to <body> — the user is mid-keyboard-navigation and the next
 * arrow press goes nowhere. Restoring by INDEX is the fix, and the clamp is the part that
 * gets forgotten: when the rebuild produced fewer rows, the remembered index can be past
 * the end.
 *
 * Returns -1 when there is nothing to focus, so the caller leaves focus alone rather than
 * reaching for element 0 of an empty list.
 */
export function focusIndexAfterRebuild(previousIndex: number, nextCount: number): number {
  if (nextCount <= 0) return -1
  if (previousIndex < 0) return -1
  return Math.min(previousIndex, nextCount - 1)
}

/**
 * Where focus goes after a KEYED list rebuilds in place.
 *
 * `focusIndexAfterRebuild` restores by position, which is right when the rows are anonymous.
 * When they have identity — provider tiles, palette chips — position is the wrong thing to
 * hold onto: a rebuild that inserts or removes a row moves everything after it, and the caret
 * lands on a different tile than the one the user was on.
 *
 * The wizard grew two private answers to this instead. One keyed on a `data-chip` attribute
 * that was set on the chip body but never on the ▾ button, so that path always fell through to
 * <body>; the other passed no custody at all. Both are the same question, and it already has a
 * home in this module.
 *
 * Falls back to the CLAMPED INDEX when the key is gone — the row the user was on was deleted,
 * and its neighbour is the nearest honest answer. Returning -1 there is what "the ▾ button had
 * no data-chip, so give up" did, and giving up is how focus reached <body>.
 *
 * Returns an index into `nextKeys`, or -1 to leave focus alone.
 */
export function focusKeyAfterRebuild(
  previousKey: string | null,
  previousIndex: number,
  nextKeys: readonly string[]
): number {
  if (previousKey !== null) {
    const found = nextKeys.indexOf(previousKey)
    if (found !== -1) return found
  }
  // No empty-list guard here on purpose. focusIndexAfterRebuild already returns -1 for an
  // empty list, and a second copy of that rule is a second thing to keep in agreement — the
  // defect class this codebase keeps producing. (A break proof caught the duplicate: deleting
  // the guard changed nothing, which is what dead code looks like from the outside.)
  return focusIndexAfterRebuild(previousIndex, nextKeys.length)
}
