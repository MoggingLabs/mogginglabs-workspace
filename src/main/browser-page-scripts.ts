/**
 * Page-world scripts the browser driver injects (`agentAct`, browser-dock.ts). One
 * module of string builders so the driver reads as verbs, not blobs. Everything here
 * runs INSIDE the untrusted guest page (executeJavaScript): scripts are
 * self-contained IIFEs, every interpolated value is JSON.stringify'd, and nothing
 * returns page objects — primitives and plain JSON only (the executeJavaScript
 * clone rule).
 *
 * The agent's eyes and hands walk what the USER sees: open shadow roots and
 * same-origin iframes are part of the page (web-component apps, Storybook, embedded
 * auth frames), so the snapshot collector and the ref resolver both descend into
 * them. Cross-origin frames stay opaque — the try/catch is the boundary, not a
 * failure.
 */

/** Snapshot stops collecting past this many interactive nodes and says so
 *  (`truncated`) — a dense dashboard must not become a megabyte MCP payload. */
export const SNAPSHOT_NODE_CAP = 300

/** Inline prelude defining `__mogFind(target)`: resolve a snapshot ref
 *  (data-mog-ref) through document, open shadow roots, and same-origin iframes —
 *  the same tree the snapshot stamped — falling back to treating `target` as a CSS
 *  selector (document scope) so agents can address elements they never snapshotted. */
const FIND_PRELUDE = `
  const __mogFindIn = (root, sel, depth) => {
    if (depth > 20) return null
    let el = null
    try { el = root.querySelector(sel) } catch (e) { return null }
    if (el) return el
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) { const f = __mogFindIn(host.shadowRoot, sel, depth + 1); if (f) return f }
    }
    for (const frame of root.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) { const f = __mogFindIn(frame.contentDocument, sel, depth + 1); if (f) return f } } catch (e) { /* cross-origin */ }
    }
    return null
  }
  const __mogFind = (target) => {
    const byRef = __mogFindIn(document, '[data-mog-ref=' + JSON.stringify(target) + ']', 0)
    if (byRef) return byRef
    try { return document.querySelector(target) } catch (e) { return null }
  }`

export const SNAPSHOT_JS = `(() => {
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[onclick],summary'
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const nodes = []
  let truncated = false
  let i = 0
  const collect = (root, depth) => {
    if (truncated || depth > 20) return
    for (const el of root.querySelectorAll(sel)) {
      if (nodes.length >= ${SNAPSHOT_NODE_CAP}) { truncated = true; return }
      if (!vis(el)) continue
      const ref = 'e' + (++i)
      el.setAttribute('data-mog-ref', ref)
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim().slice(0, 80)
      nodes.push({ ref, role: (el.getAttribute('role') || el.tagName.toLowerCase()), name })
    }
    for (const host of root.querySelectorAll('*')) {
      if (truncated) return
      if (host.shadowRoot) collect(host.shadowRoot, depth + 1)
    }
    for (const frame of root.querySelectorAll('iframe')) {
      if (truncated) return
      try { if (frame.contentDocument) collect(frame.contentDocument, depth + 1) } catch (e) { /* cross-origin */ }
    }
  }
  collect(document, 0)
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 4000)
  return { nodes, text, truncated, url: location.href, title: document.title }
})()`

/** The full pointer gesture, not `el.click()`: pointer-first widgets (menus,
 *  comboboxes, drag handles) listen for pointerdown/up and never hear a bare click.
 *  The trailing `el.click()` keeps native activation (labels, checkboxes, links). */
export function clickScript(target: string): string {
  return `(() => {
  ${FIND_PRELUDE}
  const el = __mogFind(${JSON.stringify(target)})
  if (!el) return false
  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) { /* detached */ }
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
  const pointer = { pointerId: 1, isPrimary: true, pointerType: 'mouse' }
  el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, at, pointer)))
  el.dispatchEvent(new MouseEvent('mousedown', at))
  if (el.focus) try { el.focus() } catch (e) { /* unfocusable */ }
  el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, at, pointer)))
  el.dispatchEvent(new MouseEvent('mouseup', at))
  el.click()
  return true
})()`
}

/** Write through the PROTOTYPE's value setter, then dispatch. React (and every
 *  tracker-style framework) wraps the INSTANCE's `value` to dedupe events: a plain
 *  `el.value = x` updates the tracker too, so the dispatched 'input' reads as "no
 *  change" and onChange never fires (finding B2). The prototype setter leaves the
 *  tracker stale — the same trick every real driver uses. */
export function typeScript(target: string, value: string): string {
  return `(() => {
  ${FIND_PRELUDE}
  const el = __mogFind(${JSON.stringify(target)})
  if (!el) return false
  try { el.focus() } catch (e) { /* unfocusable */ }
  const v = ${JSON.stringify(value)}
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
  if (desc && desc.set) desc.set.call(el, v)
  else if (el.isContentEditable) el.textContent = v
  else if ('value' in el) el.value = v
  else return false
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: v, inputType: 'insertText' }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  // Verify it LANDED — a constrained field (<input type=number> given letters, a
  // maxlength/pattern/readonly input) silently drops the value; reporting ok then would
  // let an agent submit an empty required field thinking it typed. Empty target = cleared.
  const now = el.isContentEditable ? (el.textContent || '') : ('value' in el ? el.value : '')
  return v === '' ? now === '' : now !== ''
})()`
}

/** Same prototype-setter rule as typeScript — a React-controlled <select> dedupes
 *  the change event identically. */
export function selectScript(target: string, value: string): string {
  return `(() => {
  ${FIND_PRELUDE}
  const el = __mogFind(${JSON.stringify(target)})
  if (!el) return false
  const v = ${JSON.stringify(value)}
  const desc = el instanceof HTMLSelectElement ? Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value') : null
  if (desc && desc.set) desc.set.call(el, v)
  else if ('value' in el) el.value = v
  else return false
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  // A <select> accepts the value only if an <option> matches; otherwise value stays put.
  // Report the truth so an agent doesn't proceed on a selection that never took.
  return 'value' in el ? el.value === v : false
})()`
}

/** Does the target exist yet — the wait_for probe. */
export function existsScript(target: string): string {
  return `(() => {
  ${FIND_PRELUDE}
  return !!__mogFind(${JSON.stringify(target)})
})()`
}

/** Relative scroll by default; absolute when `to === 'y'` (the contract's
 *  documented-but-unimplemented mode — finding B5). */
export function scrollScript(dy: number, to?: 'y'): string {
  const px = Number.isFinite(dy) ? Number(dy) : 400
  return to === 'y' ? `window.scrollTo(0, ${px})` : `window.scrollBy(0, ${px})`
}
