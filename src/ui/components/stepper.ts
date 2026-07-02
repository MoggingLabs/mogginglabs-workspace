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
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/** [− n +] numeric stepper. */
export function createStepper(opts: StepperOpts = {}): StepperHandle {
  const min = opts.min ?? 0
  let max = opts.max ?? 99
  let value = clamp(opts.value ?? 0, min, max)

  const valueEl = el('span', {
    class: 'stepper-value',
    text: String(value),
    ariaLabel: opts.ariaLabel
  })
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

  function refresh(): void {
    valueEl.textContent = String(value)
    dec.disabled = value <= min
    inc.disabled = value >= max
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
    el: el('div', { class: 'stepper' }, [dec, valueEl, inc]),
    value: () => value,
    setValue: (n) => set(n, false),
    setMax: (m) => {
      max = Math.max(min, m)
      set(value, false)
    }
  }
}
