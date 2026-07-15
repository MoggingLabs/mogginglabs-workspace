import { el } from './dom'
import { icon, type IconName } from './icons'

export type ToastTone = 'neutral' | 'attention' | 'success' | 'danger' | 'info'

export interface ToastOpts {
  title: string
  body?: string
  tone?: ToastTone
  icon?: IconName
  /** ms until auto-dismiss (0 = sticky). Default 6000. */
  timeout?: number
  action?: { label: string; onClick: () => void }
  /** A second, quieter labeled choice (e.g. "Later") — dismisses after running. */
  secondaryAction?: { label: string; onClick: () => void }
}

const MAX_STACK = 4
/** Toasts past the visible cap WAIT here instead of being destroyed — a batch
 *  of five alerts used to evict the oldest before a frame painted, while the
 *  sender had already spent its single-fire state (phase-11 audit, RC3). */
const MAX_QUEUE = 20
const pending: ToastOpts[] = []
const TONE_ICON: Record<ToastTone, IconName> = {
  neutral: 'bell',
  attention: 'bell',
  success: 'check-circle',
  danger: 'alert',
  info: 'info'
}

let host: HTMLElement | null = null

function ensureHost(): HTMLElement {
  if (!host || !host.isConnected) {
    host = el('div', {
      class: 'toast-host',
      role: 'region',
      ariaLabel: 'Notifications',
      attrs: { 'aria-live': 'polite' }
    })
    document.body.append(host)
  }
  return host
}

interface QueueEntry {
  opts: ToastOpts
  dismiss: (() => void) | null
  cancelled: boolean
}
const queue: QueueEntry[] = []

/** A slot opened — seat the oldest waiting toast (skipping cancelled ones). */
function pump(): void {
  const stack = ensureHost()
  while (queue.length && stack.childElementCount < MAX_STACK) {
    const entry = queue.shift()!
    if (entry.cancelled) continue
    entry.dismiss = mount(entry.opts)
  }
}

/** Show a toast (e.g. a `mogging notify` event). Returns a dismisser. A full
 *  stack QUEUES — a toast is never destroyed before it has been seen. */
export function showToast(opts: ToastOpts): () => void {
  const stack = ensureHost()
  if (stack.childElementCount >= MAX_STACK) {
    const entry: QueueEntry = { opts, dismiss: null, cancelled: false }
    if (queue.length >= MAX_QUEUE) queue.shift() // a hard cap, oldest news yields
    queue.push(entry)
    return () => {
      entry.cancelled = true
      entry.dismiss?.()
    }
  }
  return mount(opts)
}

function mount(opts: ToastOpts): () => void {
  const stack = ensureHost()
  const tone = opts.tone ?? 'neutral'

  let timer: ReturnType<typeof setTimeout> | undefined

  const removeNow = (): void => {
    if (!toast.isConnected) return
    toast.remove()
    pump()
  }
  const dismiss = (): void => {
    if (timer) clearTimeout(timer)
    if (!toast.isConnected) return
    toast.classList.add('is-leaving')
    toast.addEventListener('animationend', removeNow, { once: true })
    setTimeout(removeNow, 260) // reduced-motion fallback
  }

  const toast = el('div', { class: `toast toast--${tone}`, role: 'status' }, [
    el('span', { class: 'toast-icon' }, [icon(opts.icon ?? TONE_ICON[tone], 16)]),
    el('div', { class: 'toast-content' }, [
      el('div', { class: 'toast-title', text: opts.title }),
      opts.body ? el('div', { class: 'toast-body', text: opts.body }) : null
    ]),
    opts.secondaryAction
      ? el('button', {
          class: 'toast-action toast-action--secondary',
          type: 'button',
          text: opts.secondaryAction.label,
          onClick: () => {
            opts.secondaryAction!.onClick()
            dismiss()
          }
        })
      : null,
    opts.action
      ? el('button', {
          class: 'toast-action',
          type: 'button',
          text: opts.action.label,
          onClick: () => {
            opts.action!.onClick()
            dismiss()
          }
        })
      : null,
    el(
      'button',
      {
        class: 'toast-dismiss icon-btn',
        type: 'button',
        ariaLabel: 'Dismiss',
        onClick: dismiss
      },
      [icon('x', 12)]
    )
  ])

  stack.append(toast)

  const timeout = opts.timeout ?? 6000
  if (timeout > 0) timer = setTimeout(dismiss, timeout)
  return dismiss
}
