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

export interface CountBadgeOpts {
  /** Loud (orange fill + glow) — for attention counts. */
  attention?: boolean
  /** Accessible label; defaults to a pane-count phrasing (the rail's original use). */
  label?: string
}

/** Small numeric badge, tabular-nums so it never jitters as the count changes. */
export function CountBadge(count: number, opts: CountBadgeOpts = {}): HTMLElement {
  const attention = opts.attention ?? false
  return el('span', {
    class: attention ? 'count-badge count-badge--attention' : 'count-badge',
    text: String(count),
    ariaLabel:
      opts.label ??
      (attention
        ? `${count} ${count === 1 ? 'pane needs' : 'panes need'} attention`
        : `${count} ${count === 1 ? 'pane' : 'panes'}`)
  })
}
