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
