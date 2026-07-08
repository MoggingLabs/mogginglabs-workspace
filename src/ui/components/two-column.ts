import { el, type ElChild } from './dom'

/**
 * TwoColumn — the nav|content and form|preview shell (8.5/01). One place owns
 * the gutter, the sidebar width, and the readable-column cap, so Settings, the
 * wizard, and any future split screen agree without re-deriving them.
 *
 *   TwoColumn({ side: nav, ariaLabel: 'Settings sections' }, [contentCol])
 *
 * `side` is the narrow rail (nav or preview); children are the main column.
 * `sideAt: 'end'` puts the rail on the right (form|preview). Below
 * `--tc-stack-at` the columns stack — a desktop app still gets narrow windows.
 */
export interface TwoColumnOpts {
  side: Node
  /** Rail on the left (nav|content, default) or the right (form|preview). */
  sideAt?: 'start' | 'end'
  /** Cap the main column at the readable page width. Default true. */
  measure?: boolean
  /** Landmark label when the rail is a nav. Renders <nav> instead of <div>. */
  ariaLabel?: string
  class?: string
}

export function TwoColumn(opts: TwoColumnOpts, children: ElChild[] = []): HTMLElement {
  const rail = opts.ariaLabel
    ? el('nav', { class: 'two-column-side', ariaLabel: opts.ariaLabel }, [opts.side])
    : el('div', { class: 'two-column-side' }, [opts.side])

  const main = el(
    'div',
    { class: ['two-column-main', opts.measure === false ? '' : 'two-column-main--measured'].filter(Boolean).join(' ') },
    children
  )

  const cls = [
    'two-column',
    opts.sideAt === 'end' ? 'two-column--side-end' : '',
    opts.class ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  return el('div', { class: cls }, opts.sideAt === 'end' ? [main, rail] : [rail, main])
}
