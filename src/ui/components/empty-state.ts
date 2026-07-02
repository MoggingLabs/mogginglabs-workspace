import { el } from './dom'
import { icon, type IconName } from './icons'

export interface EmptyStateOpts {
  icon?: IconName
  title: string
  body?: string
  action?: Node
}

export function EmptyState(opts: EmptyStateOpts): HTMLElement {
  return el('div', { class: 'empty-state' }, [
    opts.icon ? el('span', { class: 'empty-icon' }, [icon(opts.icon, 28)]) : null,
    el('div', { class: 'empty-title', text: opts.title }),
    opts.body ? el('div', { class: 'empty-body', text: opts.body }) : null,
    opts.action ?? null
  ])
}
