import { el } from './dom'
import { icon } from './icons'

export interface CheckboxOpts {
  checked?: boolean
  label?: string
  ariaLabel?: string
  /** Really disables the input (8.5/02). Callers must NOT fake this with
   *  `pointer-events: none` — that leaves the box keyboard-focusable and
   *  togglable while also blocking selection of the explanatory hint. */
  disabled?: boolean
  onChange?: (checked: boolean) => void
}

export interface CheckboxHandle {
  el: HTMLLabelElement
  checked(): boolean
  setChecked(checked: boolean): void
  setDisabled(disabled: boolean): void
}

export function createCheckbox(opts: CheckboxOpts = {}): CheckboxHandle {
  const input = el('input', {
    type: 'checkbox',
    ariaLabel: opts.ariaLabel ?? opts.label,
    onChange: () => opts.onChange?.(input.checked)
  })
  input.checked = !!opts.checked
  input.disabled = !!opts.disabled

  const root = el('label', { class: 'checkbox' }, [
    input,
    el('span', { class: 'checkbox-box' }, [icon('check')]),
    opts.label ? el('span', { class: 'checkbox-label', text: opts.label }) : null
  ])
  root.classList.toggle('is-disabled', !!opts.disabled)

  return {
    el: root,
    checked: () => input.checked,
    setChecked: (checked) => {
      input.checked = checked
    },
    setDisabled: (disabled) => {
      input.disabled = disabled
      root.classList.toggle('is-disabled', disabled)
    }
  }
}
