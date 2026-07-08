import { el } from './dom'
import { icon } from './icons'

/**
 * A `Card` that folds (Phase-8.5/05). The unit of progressive disclosure for the two
 * mega-tabs: nine sections rendered at once is a wall, so everything but the overview
 * and whatever needs you starts closed.
 *
 * THE RULE THAT SHAPES IT: **collapse is not hide.** A section's attention state —
 * a needs-auth chip, a failing webhook, a refused act, a pending restart — renders in
 * the HEADER, which is always visible. Fold the detail, never the signal.
 *
 * And the body is only ever `hidden`, never unbuilt. Folding must not change what is
 * in the DOM: `.click()` and `textContent` both reach through `display: none`, so
 * every existing gate keeps working, and no section defers its IPC to first-expand.
 *
 * Not `<details>`: the header carries a toggle, live attention chips, AND action
 * buttons. A `<summary>` may not contain interactive descendants, so the toggle is a
 * real `<button aria-expanded aria-controls>` beside its siblings — the pattern the
 * APG disclosure spec actually describes.
 */
export interface CollapsibleCardOpts {
  /** Stable id: the persistence key and the `data-collapsible` hook. */
  id: string
  title: string
  /** A string becomes the house caption; a Node is mounted as-is (keeps its classes). */
  caption?: string | Node
  /** Extra classes on the card root — e.g. a smoke's scoping hook. */
  class?: string
  /** Buttons that belong to the section, not to the fold (palette verbs, "Add…"). */
  actions?: Node | null
  /**
   * Does attention force this section open?
   * TRUE for attention that demands an action (auth expired, webhook down, restart
   * pending). FALSE for attention that merely reports a fact — a refused act is the
   * trail doing its job, not a summons. Both still SHOW in the header.
   */
  attentionOpens?: boolean
  /** Open when nothing is stored. Default false — a mega-tab opens quiet. */
  defaultOpen?: boolean
  /** Namespace for the stored open/closed bit. */
  storagePrefix?: string
  onToggle?: (open: boolean) => void
}

export interface CollapsibleCardHandle {
  el: HTMLElement
  /** Where the section's real content goes. */
  body: HTMLElement
  isOpen(): boolean
  /** `persist: false` for machine-driven opens (attention) — never overwrite intent. */
  setOpen(open: boolean, opts?: { persist?: boolean }): void
  /** Replace the header's attention slot. Null clears it. */
  setAttention(node: Node | null): void
}

let seq = 0

const read = (key: string): boolean | null => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? null : v === '1'
  } catch {
    return null // storage unavailable — fall back to the default, never throw
  }
}
const write = (key: string, open: boolean): void => {
  try {
    localStorage.setItem(key, open ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

export function createCollapsibleCard(opts: CollapsibleCardOpts, children: Node[] = []): CollapsibleCardHandle {
  const key = `mogging.disclosure.${opts.storagePrefix ?? 'app'}.${opts.id}`
  const bodyId = `cc-body-${++seq}`
  const titleId = `cc-title-${seq}`

  const chevron = icon('chevron-right', 14)
  const title = el('span', { class: 'cc-title', text: opts.title })
  title.id = titleId

  const toggle = el('button', { class: 'cc-toggle', type: 'button' }, [chevron, title])
  toggle.setAttribute('aria-controls', bodyId)

  const attnSlot = el('div', { class: 'cc-attn' })
  const actionSlot = el('div', { class: 'cc-actions' }, opts.actions ? [opts.actions] : [])

  const caption =
    typeof opts.caption === 'string' ? el('p', { class: 'cc-caption', text: opts.caption }) : (opts.caption ?? null)

  const body = el('div', { class: 'card-body cc-body' }, children)
  body.id = bodyId
  body.setAttribute('role', 'region')
  body.setAttribute('aria-labelledby', titleId)

  const cls = ['card', 'collapsible-card', opts.class ?? ''].filter(Boolean).join(' ')
  const root = el('section', { class: cls, dataset: { collapsible: opts.id } }, [
    el('div', { class: 'cc-head' }, [toggle, attnSlot, actionSlot]),
    caption,
    body
  ])

  let open = false

  function apply(next: boolean): void {
    open = next
    body.hidden = !next
    root.classList.toggle('is-open', next)
    toggle.setAttribute('aria-expanded', String(next))
  }

  function setOpen(next: boolean, o: { persist?: boolean } = {}): void {
    apply(next)
    if (o.persist !== false) write(key, next)
    opts.onToggle?.(next)
  }

  toggle.onclick = (): void => setOpen(!open) // a hand-toggle always persists

  function setAttention(node: Node | null): void {
    attnSlot.replaceChildren()
    root.classList.toggle('has-attention', !!node)
    if (!node) return
    attnSlot.append(node)
    // Attention beats persistence — but never overwrites it. Collapse it again and
    // THAT is stored; the section only insists on being seen the first time.
    if (!open && opts.attentionOpens !== false) setOpen(true, { persist: false })
  }

  apply(read(key) ?? opts.defaultOpen ?? false)

  return { el: root, body, isOpen: () => open, setOpen, setAttention }
}
