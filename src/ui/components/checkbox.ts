import { el } from './dom'
import { icon } from './icons'

export interface CheckboxOpts {
  checked?: boolean
  label?: string
  ariaLabel?: string
  onChange?: (checked: boolean) => void
}

export interface CheckboxHandle {
  el: HTMLLabelElement
  checked(): boolean
  setChecked(checked: boolean): void
}

export function createCheckbox(opts: CheckboxOpts = {}): CheckboxHandle {
  const input = el('input', {
    type: 'checkbox',
    ariaLabel: opts.ariaLabel ?? opts.label,
    onChange: () => opts.onChange?.(input.checked)
  })
  input.checked = !!opts.checked

  const root = el('label', { class: 'checkbox' }, [
    input,
    el('span', { class: 'checkbox-box' }, [icon('check')]),
    opts.label ? el('span', { class: 'checkbox-label', text: opts.label }) : null
  ])

  return {
    el: root,
    checked: () => input.checked,
    setChecked: (checked) => {
      input.checked = checked
    }
  }
}
