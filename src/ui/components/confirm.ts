import { el } from './dom'
import { Button } from './button'
import { createCheckbox } from './checkbox'
import { createModal } from './modal'

// The shared confirm dialog (Phase-8 UX audit). One affordance for every
// irreversible action so a new destructive control is "wire the confirm", not
// "remember to". Safest defaults: Cancel is focused, Esc / backdrop / the ×
// all CANCEL, and the destructive button is danger-styled and clicked
// deliberately. An optional per-session "Don't ask again" cuts friction once
// the user has seen a given prompt.

const sessionSkip = new Set<string>() // rememberKeys the user opted out of, this run

export interface ConfirmOpts {
  title: string
  /** One line on what happens — say the consequence, not an apology. */
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button — true for anything that destroys/loses state. */
  danger?: boolean
  /** When set, offer "Don't ask again this session"; a prior opt-out for the
   *  same key resolves true immediately without showing the dialog. */
  rememberKey?: string
}

/** Resolves true if the user confirms, false on any cancel/dismiss. */
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  if (opts.rememberKey && sessionSkip.has(opts.rememberKey)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      resolve(v)
      modal.close()
    }
    const remember = opts.rememberKey ? createCheckbox({ checked: false, label: 'Don’t ask again this session' }) : null
    const cancelBtn = Button({ label: opts.cancelLabel ?? 'Cancel', variant: 'ghost', onClick: () => finish(false) })
    const confirmBtn = Button({
      label: opts.confirmLabel ?? 'Confirm',
      variant: opts.danger ? 'danger' : 'primary',
      onClick: () => {
        if (remember?.checked() && opts.rememberKey) sessionSkip.add(opts.rememberKey)
        finish(true)
      }
    })
    const footer = el('div', { class: 'confirm-footer' }, [
      remember ? remember.el : null,
      el('div', { class: 'confirm-actions' }, [cancelBtn, confirmBtn])
    ])
    const modal = createModal({
      title: opts.title,
      subtitle: opts.message,
      variant: 'dialog',
      width: 380,
      closeOnBackdrop: true,
      footer,
      onClose: () => finish(false) // Esc / backdrop / × all cancel
    })
    modal.open()
    cancelBtn.focus() // safest default — deliberate reach for the destructive button
  })
}

/** Test-only: clear the per-session "don't ask again" opt-outs. */
export function resetConfirmSkipsForSmoke(): void {
  sessionSkip.clear()
}
