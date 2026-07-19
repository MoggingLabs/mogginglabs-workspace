import { memorySlug, memoryWikilinkRe } from '@contracts'
import { EmptyState, Pill, clear, el } from '../../components'
import type { BrainBacklinkOut, BrainMemoryLinkOut, BrainMemoryOut } from './client'

/**
 * The memory READER (ADR 0018/10): one memory, rendered from the INDEXED body.
 * Memory text is agent-written and therefore UNTRUSTED — every byte lands via
 * `textContent` (the file-tree's filename discipline); no innerHTML exists in
 * this module. `[[wikilinks]]` are re-found with the indexer's OWN pattern and
 * slugger (@contracts — one truth, two readers) and become house buttons that
 * navigate the lens; a dangling target renders dimmed and "wanted"-affixed.
 * There is NO editor here: memories are edited by agents or the user's own
 * tools — ADR 0010's window-not-manager stance, extended to `.memory/`.
 */

export interface ReaderDeps {
  /** Navigate to another memory (written or dangling — the view decides how). */
  onNavigate(slug: string): void
  /** Focus the graph lens on this memory. */
  onFocusGraph(slug: string): void
}

const wikilinkButton = (raw: string, slug: string, dangling: boolean, deps: ReaderDeps): HTMLElement => {
  const btn = el(
    'button',
    {
      class: `brain-wikilink${dangling ? ' is-dangling' : ''}`,
      type: 'button',
      title: dangling ? `${slug} — wanted: linked to, not written yet` : `Open ${slug}`,
      onClick: () => deps.onNavigate(slug)
    },
    [el('span', { text: raw })]
  )
  if (dangling) btn.append(el('span', { class: 'brain-wanted', text: '· wanted' }))
  return btn
}

/** The body, tokenized with the indexer's pattern: text stays text nodes; links
 *  become buttons. A target that sanitizes to nothing was never a link. */
export function renderMemoryBody(body: string, links: BrainMemoryLinkOut[], selfSlug: string, deps: ReaderDeps): HTMLElement {
  const dangling = new Map(links.map((l) => [l.slug, l.dangling]))
  const host = el('div', { class: 'brain-reader-body' })
  const re = memoryWikilinkRe()
  let last = 0
  for (const m of body.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) host.append(document.createTextNode(body.slice(last, at)))
    const slug = memorySlug(m[1])
    if (!slug) {
      host.append(document.createTextNode(m[0])) // sanitized to nothing = plain text
    } else if (slug === selfSlug) {
      host.append(document.createTextNode(m[0])) // a self-link navigates nowhere
    } else {
      host.append(wikilinkButton(m[0], slug, dangling.get(slug) ?? false, deps))
    }
    last = at + m[0].length
  }
  if (last < body.length) host.append(document.createTextNode(body.slice(last)))
  return host
}

export interface ReaderModel {
  memory: BrainMemoryOut
  links: BrainMemoryLinkOut[]
  backlinks: BrainBacklinkOut[]
  truncated: boolean
}

/** A slug row in the links/backlinks rails — the same button, list-shaped. */
const slugRow = (slug: string, dangling: boolean, deps: ReaderDeps): HTMLElement =>
  el('li', {}, [wikilinkButton(slug, slug, dangling, deps)])

export function renderReader(host: HTMLElement, model: ReaderModel, deps: ReaderDeps): void {
  clear(host)
  const m = model.memory
  const head = el('div', { class: 'brain-reader-head' }, [
    el('h2', { class: 'brain-reader-title', text: m.name }),
    Pill({ text: m.slug, tone: 'accent', title: 'The memory’s slug — its filename in .memory/' }),
    ...m.tags.map((t) => Pill({ text: t, title: 'tag' }))
  ])
  const sub = el('p', { class: 'brain-reader-sub', text: m.description })
  const from = el('p', { class: 'brain-reader-root', text: `.memory/${m.slug}.md · ${m.root}`, title: 'The checkout serving the freshest copy' })

  const body = renderMemoryBody(m.body, model.links, m.slug, deps)
  const truncated = model.truncated
    ? el('p', { class: 'brain-reader-truncated', text: 'Trimmed to fit the read cap — the file on disk holds the rest.' })
    : null

  const rails = el('div', { class: 'brain-reader-rails' }, [
    el('div', { class: 'brain-reader-rail' }, [
      el('h3', { class: 'brain-reader-rail-title', text: `Links (${model.links.length})` }),
      model.links.length
        ? el('ul', { class: 'brain-reader-list' }, model.links.map((l) => slugRow(l.slug, l.dangling, deps)))
        : el('p', { class: 'brain-reader-none', text: 'No outgoing links.' })
    ]),
    el('div', { class: 'brain-reader-rail' }, [
      el('h3', { class: 'brain-reader-rail-title', text: `Backlinks (${model.backlinks.length})` }),
      model.backlinks.length
        ? el('ul', { class: 'brain-reader-list' }, model.backlinks.map((b) => slugRow(b.slug, false, deps)))
        : el('p', { class: 'brain-reader-none', text: 'Nothing links here yet.' })
    ])
  ])

  host.append(head, sub, from, body)
  if (truncated) host.append(truncated)
  host.append(rails)
}

/** A DANGLING slug opened in the reader: not an error — wanted knowledge, with
 *  the wanters listed. Agents (or you) write it; this surface never will. */
export function renderWanted(host: HTMLElement, slug: string, backlinks: BrainBacklinkOut[], deps: ReaderDeps): void {
  clear(host)
  host.append(
    EmptyState({
      icon: 'bookmark',
      title: `“${slug}” is wanted, not written`,
      body: backlinks.length
        ? `${backlinks.length} memor${backlinks.length === 1 ? 'y links' : 'ies link'} to it. A dangling link marks knowledge the team wants — an agent (or your own editor) writes the file.`
        : 'Nothing links to it either — this slug is unknown to the project.'
    })
  )
  if (backlinks.length) {
    host.append(
      el('div', { class: 'brain-reader-rail brain-reader-wanted' }, [
        el('h3', { class: 'brain-reader-rail-title', text: 'Wanted by' }),
        el('ul', { class: 'brain-reader-list' }, backlinks.map((b) => slugRow(b.slug, false, deps)))
      ])
    )
  }
}
