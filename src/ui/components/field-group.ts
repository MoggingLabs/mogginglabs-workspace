import { el } from './dom'

/**
 * FieldGroup — label + hint + control on ONE vertical rhythm (8.5/01).
 * The generalized form of two ad-hoc predecessors: the wizard's `.field`
 * (inline hint) and Settings' local `row()` helper (`.settings-row`). Steps
 * 02/04 absorb both into this.
 *
 *   FieldGroup({ label: 'Theme', hint: 'System follows your OS.' }, themeSeg.el)
 *
 * The hint sits under the LABEL by default (the house pattern — you read what
 * the knob means before you touch it); `hintPlacement: 'below-control'` is
 * there for controls whose hint is really a result caveat.
 *
 * A11y: when the control is a labelable element we bind <label for>; otherwise
 * the group is a `group` with an aria-labelledby, so a segmented control or a
 * checkbox stack still announces its name.
 */
let seq = 0

export interface FieldGroupOpts {
  label: string
  hint?: string
  hintPlacement?: 'below-label' | 'below-control'
  /** Marks the control invalid + renders `error` in place of the hint. */
  error?: string
  class?: string
}

const LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS'])

export function FieldGroup(opts: FieldGroupOpts, control: Node): HTMLElement {
  const id = `fg-${++seq}`
  const labelable = control instanceof HTMLElement && LABELABLE.has(control.tagName)

  if (labelable && !(control as HTMLElement).id) (control as HTMLElement).id = `${id}-control`

  const label = labelable
    ? el('label', { class: 'field-group-label', text: opts.label, attrs: { for: (control as HTMLElement).id } })
    : el('span', { class: 'field-group-label', text: opts.label, attrs: { id: `${id}-label` } })

  // The control announces its own description/error (shadcn Field's contract):
  // aria-describedby -> the note, aria-invalid when errored.
  const noteId = `${id}-note`
  const note = opts.error
    ? el('span', { class: 'field-group-error', role: 'alert', text: opts.error, attrs: { id: noteId } })
    : opts.hint
      ? el('span', { class: 'field-group-hint', text: opts.hint, attrs: { id: noteId } })
      : null
  if (note && control instanceof HTMLElement) {
    control.setAttribute('aria-describedby', noteId)
    if (opts.error) control.setAttribute('aria-invalid', 'true')
  }
  const below = opts.hintPlacement === 'below-control'

  const head = el('div', { class: 'field-group-head' }, [label, below ? null : note])

  const group = el(
    'div',
    {
      class: ['field-group', opts.error ? 'is-invalid' : '', opts.class ?? ''].filter(Boolean).join(' '),
      ...(labelable ? {} : { role: 'group', attrs: { 'aria-labelledby': `${id}-label` } })
    },
    [head, el('div', { class: 'field-group-control' }, [control]), below ? note : null]
  )
  return group
}
