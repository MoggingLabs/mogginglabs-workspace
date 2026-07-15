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

/** How long a toast stays up when it doesn't say otherwise. Exported because an UNDO toast
 *  is a promise: whatever it offers to reverse has to stay reversible for exactly as long
 *  as the button is on screen, so the grace period and the toast read the same number. */
export const TOAST_DEFAULT_MS = 6000

const MAX_STACK = 4
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

/** Show a toast (e.g. a `mogging notify` event). Returns a dismisser. */
export function showToast(opts: ToastOpts): () => void {
  const stack = ensureHost()
  const tone = opts.tone ?? 'neutral'

  let timer: ReturnType<typeof setTimeout> | undefined

  const dismiss = (): void => {
    if (timer) clearTimeout(timer)
    if (!toast.isConnected) return
    toast.classList.add('is-leaving')
    toast.addEventListener('animationend', () => toast.remove(), { once: true })
    setTimeout(() => toast.remove(), 260) // reduced-motion fallback
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
  while (stack.childElementCount > MAX_STACK) stack.firstElementChild?.remove()

  const timeout = opts.timeout ?? TOAST_DEFAULT_MS
  if (timeout > 0) timer = setTimeout(dismiss, timeout)
  return dismiss
}
