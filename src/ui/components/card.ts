import { el, type ElChild } from './dom'

/**
 * Card — the padded, bordered container every grouped surface sits in (8.5/01).
 * Spacing comes from the --sp-* ramp only; nothing here hardcodes a pixel.
 *
 *   Card({ title: 'Theme', caption: 'Follows your OS.' }, [themeSeg.el])
 *
 * `title`/`caption` render a SectionHeader-shaped head inline; pass `header`
 * instead when the head needs a trailing action (use SectionHeader for that).
 * `tone: 'inset'` is the quieter variant for a card nested inside a card.
 */
export interface CardOpts {
  /** Convenience head — omit when passing `header`. */
  title?: string
  caption?: string
  /** A prebuilt head (e.g. SectionHeader with an action). Wins over title. */
  header?: Node
  footer?: Node
  tone?: 'default' | 'inset'
  /** Extra class for feature-local tweaks (never spacing — that's the ramp's job). */
  class?: string
}

export function Card(opts: CardOpts = {}, children: ElChild[] = []): HTMLElement {
  const head =
    opts.header ??
    (opts.title
      ? el('div', { class: 'card-head' }, [
          el('span', { class: 'card-title', text: opts.title }),
          opts.caption ? el('span', { class: 'card-caption', text: opts.caption }) : null
        ])
      : null)

  const cls = ['card', opts.tone === 'inset' ? 'card--inset' : '', opts.class ?? '']
    .filter(Boolean)
    .join(' ')

  return el('section', { class: cls }, [
    head,
    el('div', { class: 'card-body' }, children),
    opts.footer ? el('div', { class: 'card-foot' }, [opts.footer]) : null
  ])
}
