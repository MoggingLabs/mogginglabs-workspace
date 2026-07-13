/**
 * What every overlay owes a keyboard: focus cannot leave it, and the app behind it cannot be
 * reached — not by Tab, not by a pointer, not by a screen reader's virtual cursor.
 *
 * `inert` buys all three in one attribute, and Chromium ships it natively, so there is no
 * polyfill here ON PURPOSE. The tempting half-fix is `aria-hidden` on the background: it
 * silences the screen reader and nothing else, so Tab still walks a sighted keyboard user
 * straight out of the dialog and into a rail they cannot see. That is the exact defect the
 * audit caught (finding 30), and a fake inert would have re-shipped it wearing a better name.
 *
 * Tab still has to WRAP inside the panel, because inert only says where focus may not go —
 * at the last control, the browser hands focus to the window chrome rather than cycling back.
 *
 * Traps nest (a confirm dialog over a wizard). The background is therefore reference-counted:
 * the inner release must not un-inert an app that the outer modal is still covering.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/** How many live traps are holding each background inert. */
const held = new Map<HTMLElement, number>()

export interface OverlayTrap {
  /** Un-inert the background (if this was the last trap holding it) and stop wrapping Tab. */
  release(): void
}

/** The panel's focusable controls in DOM order. A `hidden` control is skipped: Tab would
 *  appear to stall on nothing, which reads as a broken dialog rather than an empty one. */
function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (n) => !n.hidden && (n.offsetParent !== null || n === document.activeElement)
  )
}

/** The app shell — everything an overlay covers. Overlays mount to <body>, a SIBLING of
 *  #app, so inerting #app never inerts the overlay itself. */
function appShell(): HTMLElement {
  return document.getElementById('app') ?? document.body
}

/**
 * Hold `panel` as the only reachable region until release(): the background goes inert and
 * Tab/Shift+Tab wrap at the ends instead of escaping.
 */
export function trapOverlay(panel: HTMLElement, background: HTMLElement = appShell()): OverlayTrap {
  held.set(background, (held.get(background) ?? 0) + 1)
  background.inert = true

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const items = focusables(panel)
    // An empty panel still keeps the key: letting Tab through would land focus on nothing
    // and leave the user with no way back in.
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (!panel.contains(active)) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
    // Anywhere in the middle: the browser's own Tab order is already correct, and inert
    // guarantees it cannot walk past the ends. Nothing to do.
  }
  panel.addEventListener('keydown', onKeydown)

  let released = false
  return {
    release(): void {
      if (released) return // close() can run twice (animationend + the fallback timer)
      released = true
      panel.removeEventListener('keydown', onKeydown)
      const remaining = (held.get(background) ?? 1) - 1
      if (remaining > 0) {
        held.set(background, remaining)
        return // an outer overlay is still covering the app — it stays inert
      }
      held.delete(background)
      background.inert = false
    }
  }
}
