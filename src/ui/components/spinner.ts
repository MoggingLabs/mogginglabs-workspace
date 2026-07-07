import { el } from './dom'

// A small loading indicator (UX audit STATE-01) for async lists that would
// otherwise blank out during a fetch. Spinner + a label, announced politely
// (role="status"). Under reduced-motion the ring stops (global rule) and the
// label carries the meaning.

export function Spinner(): HTMLElement {
  return el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } })
}

export function loadingRow(label = 'Loading…'): HTMLElement {
  return el('div', { class: 'loading-row', role: 'status' }, [Spinner(), el('span', { class: 'loading-row-label', text: label })])
}
