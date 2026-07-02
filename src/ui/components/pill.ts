import { el } from './dom'
import { icon, type IconName } from './icons'

export type PillTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning'

export interface PillOpts {
  text: string
  tone?: PillTone
  icon?: IconName
  title?: string
}

export function Pill(opts: PillOpts): HTMLElement {
  const cls = opts.tone && opts.tone !== 'neutral' ? `pill pill--${opts.tone}` : 'pill'
  return el('span', { class: cls, title: opts.title }, [
    opts.icon ? icon(opts.icon, 11) : null,
    el('span', { text: opts.text })
  ])
}

/** Small numeric badge. `attention` renders it loud (orange fill + glow). */
export function CountBadge(count: number, attention = false): HTMLElement {
  return el('span', {
    class: attention ? 'count-badge count-badge--attention' : 'count-badge',
    text: String(count),
    ariaLabel: attention
      ? `${count} ${count === 1 ? 'pane needs' : 'panes need'} attention`
      : `${count} ${count === 1 ? 'pane' : 'panes'}`
  })
}
