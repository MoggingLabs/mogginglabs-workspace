import { el } from './dom'

/**
 * SectionHeader — title + one-line caption + optional trailing action (8.5/01).
 * The house answer to "what lives here, and what can I do about it": every
 * grouped surface earns one line of purpose. Feeds Card via `header`.
 *
 *   SectionHeader({ title: 'Webhooks', caption: 'House events, POSTed out.',
 *                   action: Button({ label: 'Add' }) })
 *
 * `as` sets the heading level so a page keeps a sane document outline; the
 * caption is a sibling (never inside the heading) so screen readers announce
 * the title alone.
 */
export interface SectionHeaderOpts {
  title: string
  caption?: string
  action?: Node
  /** Heading level for the document outline. Default h3. */
  as?: 'h2' | 'h3' | 'h4'
  class?: string
}

export function SectionHeader(opts: SectionHeaderOpts): HTMLElement {
  const heading = el(opts.as ?? 'h3', { class: 'section-header-title', text: opts.title })
  return el('div', { class: ['section-header', opts.class ?? ''].filter(Boolean).join(' ') }, [
    el('div', { class: 'section-header-text' }, [
      heading,
      opts.caption ? el('p', { class: 'section-header-caption', text: opts.caption }) : null
    ]),
    opts.action ? el('div', { class: 'section-header-action' }, [opts.action]) : null
  ])
}
