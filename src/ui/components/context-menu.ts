import { el } from './dom'
import { icon, type IconName } from './icons'

/**
 * The house context menu (Phase-11/06) — a GENERIC primitive. It knows nothing about files,
 * the explorer, or any feature: it takes items, pops where you say, and hands selection back.
 * The explorer is its first customer; the board's ⋯ and the pane menu are its obvious next
 * ones, which is exactly why it does not import them.
 *
 * WHAT A CONTEXT MENU OWES ITS USER, and all of it is here rather than in the caller:
 *  - It is REACHABLE without a mouse (Shift+F10 / the ContextMenu key are the caller's job;
 *    everything after the popup is ours), and it is a proper `role=menu` with `menuitem`s.
 *  - Focus is ROVING — one item is tabbable, arrows move, Home/End jump, and typing a letter
 *    jumps to the next item starting with it.
 *  - It GIVES FOCUS BACK. Esc, an outside click, or picking an item all return focus to the
 *    element that opened it — a menu that strands your keyboard focus is worse than no menu.
 *  - It stays ON SCREEN: the position is clamped to the viewport, so a right-click near the
 *    bottom edge does not open a menu you cannot see.
 *  - Only ONE is ever open.
 */

export interface ContextMenuItem {
  label: string
  icon?: IconName
  /** Right-aligned hint — a shortcut, or a reason. */
  hint?: string
  disabled?: boolean
  onSelect?: () => void
}

export interface ContextMenuSeparator {
  separator: true
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

export interface ContextMenuOpts {
  items: ContextMenuEntry[]
  /** Viewport coordinates — the pointer, or the invoking row's corner for a keyboard open. */
  x: number
  y: number
  /** Focus comes back here on dismiss. */
  returnFocus?: HTMLElement | null
  ariaLabel?: string
}

export interface ContextMenuHandle {
  el: HTMLElement
  close(): void
}

const isSeparator = (e: ContextMenuEntry): e is ContextMenuSeparator => 'separator' in e

let current: ContextMenuHandle | null = null

/** Close whatever is open. Safe to call when nothing is. */
export function closeContextMenu(): void {
  current?.close()
}

export function openContextMenu(opts: ContextMenuOpts): ContextMenuHandle {
  closeContextMenu() // only ever one

  const items: HTMLButtonElement[] = []
  const menu = el('div', { class: 'ctx-menu', role: 'menu', ariaLabel: opts.ariaLabel ?? 'Context menu' })
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('blur', close)
    window.removeEventListener('resize', close)
    window.removeEventListener('wheel', close, true)
    menu.remove()
    if (current === handle) current = null
    // The caller's element gets the caret back — always, on every exit path.
    opts.returnFocus?.focus?.()
  }
  const handle: ContextMenuHandle = { el: menu, close }

  const enabled = (): HTMLButtonElement[] => items.filter((b) => !b.disabled)
  const focusItem = (b: HTMLButtonElement | undefined): void => {
    if (!b) return
    for (const other of items) other.tabIndex = other === b ? 0 : -1
    b.focus()
  }
  const step = (delta: number): void => {
    const live = enabled()
    if (!live.length) return
    const at = live.indexOf(document.activeElement as HTMLButtonElement)
    const next = at < 0 ? 0 : (at + delta + live.length) % live.length
    focusItem(live[next])
  }

  for (const entry of opts.items) {
    if (isSeparator(entry)) {
      menu.append(el('div', { class: 'ctx-sep', role: 'separator' }))
      continue
    }
    const btn = el(
      'button',
      {
        class: 'ctx-item',
        type: 'button',
        role: 'menuitem',
        tabIndex: -1,
        disabled: entry.disabled === true,
        onClick: () => {
          if (entry.disabled) return
          // Close FIRST: the action may open a dialog or move focus itself, and it must
          // not have to fight a menu that is still up.
          close()
          entry.onSelect?.()
        }
      },
      [
        el('span', { class: 'ctx-icon' }, [entry.icon ? icon(entry.icon, 14) : null]),
        el('span', { class: 'ctx-label', text: entry.label }), // textContent — labels may carry user data
        entry.hint ? el('span', { class: 'ctx-hint', text: entry.hint }) : null
      ]
    )
    if (entry.disabled) btn.setAttribute('aria-disabled', 'true')
    items.push(btn)
    menu.append(btn)
  }

  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const k = e.key
    if (k === 'Escape') return (e.preventDefault(), e.stopPropagation(), close())
    if (k === 'ArrowDown') return (e.preventDefault(), step(1))
    if (k === 'ArrowUp') return (e.preventDefault(), step(-1))
    if (k === 'Home') return (e.preventDefault(), focusItem(enabled()[0]))
    if (k === 'End') return (e.preventDefault(), focusItem(enabled().at(-1)))
    if (k === 'Tab') return (e.preventDefault(), close()) // a menu is not part of the tab order
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const hit = enabled().find((b) => (b.textContent ?? '').trim().toLowerCase().startsWith(k.toLowerCase()))
      if (hit) {
        e.preventDefault()
        focusItem(hit)
      }
    }
  })

  const onOutside = (e: Event): void => {
    if (!(e.target instanceof Node) || !menu.contains(e.target)) close()
  }

  document.body.append(menu)

  // Clamp INSIDE the viewport, measuring after the append (a menu's height depends on its
  // items). A right-click near the bottom edge must not open a menu below the fold.
  const r = menu.getBoundingClientRect()
  const pad = 8
  const x = Math.max(pad, Math.min(opts.x, window.innerWidth - r.width - pad))
  const y = Math.max(pad, Math.min(opts.y, window.innerHeight - r.height - pad))
  menu.style.left = `${Math.round(x)}px`
  menu.style.top = `${Math.round(y)}px`

  document.addEventListener('pointerdown', onOutside, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  window.addEventListener('wheel', close, true) // a menu anchored to a row must not float away from it

  current = handle
  focusItem(enabled()[0])
  return handle
}
