import { el } from './dom'

export interface MeterHandle {
  el: HTMLElement
  set(value: number, max: number): void
}

/** Horizontal fill bar (the wizard's "4 / 8 filled" meter). */
export function createMeter(value = 0, max = 1): MeterHandle {
  const fill = el('div', { class: 'meter-fill' })
  const bar = el('div', { class: 'meter', role: 'progressbar' }, [fill])

  function set(v: number, m: number): void {
    fill.style.width = m > 0 ? `${Math.max(0, Math.min(100, (v / m) * 100))}%` : '0%'
    bar.setAttribute('aria-valuenow', String(v))
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', String(m))
  }

  set(value, max)
  return { el: bar, set }
}
