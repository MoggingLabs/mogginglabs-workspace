import { el } from './dom'

export interface SegmentedOption {
  id: string
  label: string
}

export interface SegmentedHandle {
  el: HTMLElement
  value(): string
  setValue(id: string): void
}

/** Compact segmented control (Settings). */
export function createSegmented(opts: {
  options: SegmentedOption[]
  value: string
  ariaLabel?: string
  onChange: (id: string) => void
}): SegmentedHandle {
  let value = opts.value
  const buttons = new Map<string, HTMLButtonElement>()

  function apply(id: string, fire: boolean): void {
    value = id
    for (const [k, b] of buttons) {
      b.classList.toggle('is-active', k === id)
      b.setAttribute('aria-pressed', String(k === id))
    }
    if (fire) opts.onChange(id)
  }

  const root = el('div', { class: 'segmented', role: 'group', ariaLabel: opts.ariaLabel })
  for (const o of opts.options) {
    const b = el('button', {
      class: 'segmented-item',
      type: 'button',
      text: o.label,
      onClick: () => apply(o.id, true)
    })
    buttons.set(o.id, b)
    root.append(b)
  }
  apply(value, false)

  return { el: root, value: () => value, setValue: (id) => apply(id, false) }
}
