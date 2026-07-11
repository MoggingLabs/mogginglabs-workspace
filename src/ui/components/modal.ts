import { el, clear } from './dom'
import { IconButton } from './button'

export interface ModalOpts {
  title?: string
  subtitle?: string
  body?: Node
  footer?: Node
  /** dialog = compact centered card · wizard = wide flow panel. */
  variant?: 'dialog' | 'wizard'
  width?: number
  closeOnBackdrop?: boolean
  onClose?: () => void
}

export interface ModalHandle {
  el: HTMLElement
  open(): void
  close(): void
  isOpen(): boolean
  setTitle(text: string): void
  setSubtitle(text: string): void
  setBody(node: Node): void
  setFooter(node: Node): void
}

/**
 * Overlay modal / wizard shell. Esc closes (capture phase, so xterm never sees it),
 * backdrop click optionally closes, focus enters on open and returns to the opener
 * on close. Detached until open() appends it to <body>.
 */
export function createModal(opts: ModalOpts = {}): ModalHandle {
  const title = el('h2', { class: 'modal-title', text: opts.title ?? '' })
  const subtitle = el('p', {
    class: 'modal-subtitle',
    text: opts.subtitle ?? '',
    hidden: !opts.subtitle
  })
  const body = el('div', { class: 'modal-body' }, opts.body ? [opts.body] : [])
  const footer = el('div', { class: 'modal-footer' }, opts.footer ? [opts.footer] : [])

  const panel = el(
    'section',
    {
      class: `modal modal--${opts.variant ?? 'dialog'}`,
      role: 'dialog',
      ariaLabel: opts.title,
      attrs: { 'aria-modal': 'true' },
      style: opts.width ? { width: `${opts.width}px` } : {}
    },
    [
      el('header', { class: 'modal-header' }, [
        el('div', { class: 'modal-heading' }, [title, subtitle]),
        IconButton({ icon: 'x', label: 'Close', class: 'modal-close', onClick: () => close() })
      ]),
      body,
      footer
    ]
  )

  const overlay = el(
    'div',
    {
      class: 'modal-overlay',
      onMousedown: (e) => {
        if (e.target === overlay && opts.closeOnBackdrop !== false) close()
      }
    },
    [panel]
  )

  let open = false
  let opener: Element | null = null
  let dropTimer: ReturnType<typeof setTimeout> | undefined

  const onEsc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function doOpen(): void {
    if (open) return
    open = true
    opener = document.activeElement
    // The SAME overlay element is re-appended on every open (a cached handle — the ?
    // shortcuts sheet — reopens this exact node), so the last close's leftovers must go
    // first, or the second open is a trap:
    //   is-closing  its `fill: forwards` pins the overlay at opacity 0 — the sheet came
    //               back INVISIBLE while still covering the screen (fixed, inset:0,
    //               z-index 100), eating every click, and `open` was true so ? could not
    //               reopen it either.
    //   dropTimer   the close's deferred detach (below) would otherwise fire ~240ms into
    //               this new life and rip the overlay we just opened back out.
    overlay.classList.remove('is-closing')
    if (dropTimer) {
      clearTimeout(dropTimer)
      dropTimer = undefined
    }
    document.body.append(overlay)
    window.addEventListener('keydown', onEsc, true)
    panel.querySelector<HTMLElement>('input, select, button:not(.modal-close)')?.focus()
  }

  function close(): void {
    if (!open) return
    open = false
    window.removeEventListener('keydown', onEsc, true)
    // One curve out (8.5/07b): fade the overlay, detach on animationend — with a ≤260ms
    // fallback so reduced-motion / animations-off never strands the overlay in the DOM.
    overlay.classList.add('is-closing')
    const drop = (): void => {
      // A reopen overtook this close (its doOpen already stripped is-closing): the
      // overlay on screen belongs to the NEW open — dropping it now would detach a
      // live modal. The stale animationend listener lands here too, harmlessly.
      if (open) return
      if (dropTimer) {
        clearTimeout(dropTimer)
        dropTimer = undefined
      }
      overlay.remove()
    }
    overlay.addEventListener('animationend', drop, { once: true })
    dropTimer = setTimeout(drop, 240)
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    opts.onClose?.()
  }

  return {
    el: overlay,
    open: doOpen,
    close,
    isOpen: () => open,
    setTitle: (t) => {
      title.textContent = t
    },
    setSubtitle: (t) => {
      subtitle.textContent = t
      subtitle.hidden = !t
    },
    setBody: (node) => {
      clear(body)
      body.append(node)
    },
    setFooter: (node) => {
      clear(footer)
      footer.append(node)
    }
  }
}
