import { el } from './dom'

export interface StepperOpts {
  value?: number
  min?: number
  max?: number
  ariaLabel?: string
  onChange?: (value: number) => void
}

export interface StepperHandle {
  el: HTMLElement
  value(): number
  /** Programmatic set (clamped, no onChange fire). */
  setValue(n: number): void
  /** Adjust the ceiling (e.g. remaining pane capacity); clamps the value down. */
  setMax(max: number): void
  /** Disable both adjustment buttons without changing the stored value. */
  setDisabled(disabled: boolean): void
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/**
 * [− n +] numeric stepper — an APG **spinbutton**.
 *
 * The number used to live in a bare <span>: a screen reader met two unrelated buttons around a
 * piece of text and could not say what they moved, or to what, or how far it could go. And the
 * keyboard could only ever operate it the long way round — tab to "−", press it, tab to "+".
 * The wrapper now carries the role and the live aria-value*, so the control announces itself
 * ("Custom command count, 2, minimum 0, maximum 4") and answers the keys the pattern promises:
 * Up/Down step by one, Home/End go to the bounds — the same Home/End the resize separators use.
 *
 * Nothing here is a second source of truth: every announced value is written in `refresh()`, the
 * one place that already owns every visual update, and every key routes through the existing
 * `set()` — so the clamp, the disabled buttons, and the onChange contract are exactly the ones
 * the mouse has always had (a press that cannot move the value fires no onChange, because `set`
 * returns early when it does not change).
 */
export function createStepper(opts: StepperOpts = {}): StepperHandle {
  const min = opts.min ?? 0
  let max = opts.max ?? 99
  let value = clamp(opts.value ?? 0, min, max)
  let disabled = false

  const valueEl = el('span', { class: 'stepper-value', text: String(value) })
  const dec = el('button', {
    class: 'stepper-btn',
    type: 'button',
    text: '−',
    ariaLabel: 'Decrease',
    onClick: () => set(value - 1, true)
  })
  const inc = el('button', {
    class: 'stepper-btn',
    type: 'button',
    text: '+',
    ariaLabel: 'Increase',
    onClick: () => set(value + 1, true)
  })

  const wrap = el(
    'div',
    {
      class: 'stepper',
      role: 'spinbutton',
      tabIndex: 0, // the spinbutton IS the tab stop the keys below belong to
      // The label was on the <span>, where it named nothing (aria-label on a generic element is
      // not exposed): it belongs to the control that now has a role to hang it on.
      ariaLabel: opts.ariaLabel,
      onKeydown: (e: KeyboardEvent) => {
        if (disabled || e.ctrlKey || e.metaKey || e.altKey) return
        // A press that lands on a bound is CLAMPED, not refused: set() keeps the value and fires
        // nothing, so holding Up at the ceiling can never emit an out-of-range onChange.
        if (e.key === 'ArrowUp') set(value + 1, true)
        else if (e.key === 'ArrowDown') set(value - 1, true)
        else if (e.key === 'Home') set(min, true)
        else if (e.key === 'End') set(max, true)
        else return // every other key stays the page's (Tab must still leave, Esc must still close)
        e.preventDefault() // ...and the arrows must not scroll the card out from under the control
      }
    },
    [dec, valueEl, inc]
  )

  function refresh(): void {
    valueEl.textContent = String(value)
    dec.disabled = disabled || value <= min
    inc.disabled = disabled || value >= max
    // Announced from the SAME line that renders it — the two cannot drift, and setMax()'s clamp
    // (the wizard shrinks a stepper's ceiling as other agents take panes) rides through here too.
    wrap.setAttribute('aria-valuenow', String(value))
    wrap.setAttribute('aria-valuemin', String(min))
    wrap.setAttribute('aria-valuemax', String(max))
    wrap.setAttribute('aria-disabled', String(disabled))
  }

  function set(n: number, fire: boolean): void {
    const next = clamp(n, min, max)
    if (next === value) {
      refresh()
      return
    }
    value = next
    refresh()
    if (fire) opts.onChange?.(value)
  }

  refresh()

  return {
    el: wrap,
    value: () => value,
    setValue: (n) => set(n, false),
    setMax: (m) => {
      max = Math.max(min, m)
      set(value, false)
    },
    setDisabled: (next) => {
      disabled = next
      refresh()
    }
  }
}
