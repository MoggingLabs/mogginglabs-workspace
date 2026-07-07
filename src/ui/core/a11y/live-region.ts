// A single shared ARIA live region (UX audit A11Y-01). Dynamic status that
// isn't a toast — usage refreshed, an agent needs you, a validation refusal —
// is written here so screen readers announce it. Visually hidden; polite by
// default, assertive for things the user must hear now (refusals).

let politeEl: HTMLElement | null = null
let assertiveEl: HTMLElement | null = null

function region(assertive: boolean): HTMLElement {
  const existing = assertive ? assertiveEl : politeEl
  if (existing && existing.isConnected) return existing
  const el = document.createElement('div')
  el.className = 'sr-only'
  el.setAttribute('aria-live', assertive ? 'assertive' : 'polite')
  el.setAttribute('aria-atomic', 'true')
  el.setAttribute('role', assertive ? 'alert' : 'status')
  document.body.append(el)
  if (assertive) assertiveEl = el
  else politeEl = el
  return el
}

/** Announce a message to assistive tech. Re-announces identical text by
 *  clearing first (screen readers ignore an unchanged node). */
export function announce(message: string, assertive = false): void {
  const msg = message.trim()
  if (!msg) return
  const el = region(assertive)
  el.textContent = ''
  // A microtask gap so AT registers the change even when the text repeats.
  requestAnimationFrame(() => {
    el.textContent = msg
  })
}
