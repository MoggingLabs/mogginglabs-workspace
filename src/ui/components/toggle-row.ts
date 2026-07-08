import { el } from './dom'

/**
 * A settings toggle, as one row: label left, switch right, hint underneath
 * (Phase-8.5/04). The shape every settings page converges on, because it puts the
 * decision and its consequence on the same line and its explanation directly under
 * the thing it explains — instead of a checkbox trailed by a 340-character paragraph.
 *
 * `createCheckbox` stays for in-form, list, and inline uses (the wizard's worktree
 * box, the folder browser's "show hidden"). A switch means "this setting is on/off,
 * right now, and it applies immediately"; a checkbox means "include this in what I
 * am about to submit". They are not interchangeable, so this is a new component
 * rather than a variant flag.
 *
 * The hint is wired with `aria-describedby`, so a screen reader reads the
 * consequence when the control takes focus — which is the only time it matters.
 */
export interface ToggleRowOpts {
  label: string
  /** One sentence on what turning this on actually does. */
  hint?: string
  checked?: boolean
  disabled?: boolean
  /** Why it is disabled, or any trailing chip/link. Rendered under the hint. */
  extra?: Node | null
  onChange?: (checked: boolean) => void
}

export interface ToggleRowHandle {
  el: HTMLElement
  input: HTMLInputElement
  checked(): boolean
  setChecked(checked: boolean): void
  setDisabled(disabled: boolean): void
}

let seq = 0

export function createToggleRow(opts: ToggleRowOpts): ToggleRowHandle {
  const id = `tgl-${++seq}`
  const hintId = `${id}-hint`

  const input = el('input', {
    type: 'checkbox',
    class: 'switch-input',
    disabled: opts.disabled,
    onChange: () => opts.onChange?.(input.checked)
  })
  input.id = id
  input.checked = !!opts.checked
  if (opts.hint) input.setAttribute('aria-describedby', hintId)

  const control = el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'switch-track' }, [el('span', { class: 'switch-thumb' })])
  ])
  control.htmlFor = id

  const label = el('label', { class: 'toggle-row-label', text: opts.label })
  label.htmlFor = id

  const hint = opts.hint ? el('p', { class: 'toggle-row-hint', text: opts.hint }) : null
  if (hint) hint.id = hintId

  const root = el('div', { class: 'toggle-row' }, [
    el('div', { class: 'toggle-row-text' }, [label, hint, opts.extra ?? null]),
    control
  ])
  root.classList.toggle('is-disabled', !!opts.disabled)

  return {
    el: root,
    input,
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
