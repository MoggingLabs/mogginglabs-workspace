import { Button, EmptyState, Pill, clear, el } from '../../components'
import type { BrainNeighborOut } from './client'
import type { FocusNode } from './graph'

/**
 * The INSPECTOR (ADR 0018/10): the right column that answers "what am I looking
 * at" for the selected node — kind, signature, file:line, neighbors, backlinks.
 * Names, signatures and paths are index content = UNTRUSTED: textContent only.
 * Deep actions DELEGATE: code goes to the explorer (never an embedded editor),
 * memories go to the reader.
 */

export interface InspectorDeps {
  /** Re-aim the lens at this node. */
  onFocus(node: FocusNode): void
  /** Reveal a CODE node's file in the explorer dock. */
  onReveal(node: FocusNode): void
  /** Open a MEMORY node in the reader. */
  onRead(slug: string): void
}

export interface InspectorModel {
  node: FocusNode
  /** The selected node's own neighbors (fetched on selection; capped small). */
  neighbors: BrainNeighborOut[]
  neighborsTruncated: boolean
}

const KIND_TONE: Record<string, 'accent' | 'neutral'> = { memory: 'accent' }

export function renderInspector(host: HTMLElement, model: InspectorModel | null, deps: InspectorDeps): void {
  clear(host)
  if (!model) {
    host.append(
      EmptyState({
        icon: 'search',
        title: 'Nothing selected',
        body: 'Search for a symbol or a memory, or click a node in the lens.'
      })
    )
    return
  }
  const n = model.node
  const isMem = n.kind === 'memory'
  const slug = isMem ? n.id.slice(4) : null

  host.append(
    el('div', { class: 'brain-inspect-head' }, [
      Pill({ text: n.dangling ? 'memory · wanted' : n.kind, tone: KIND_TONE[n.kind] ?? 'neutral' }),
      el('h2', { class: 'brain-inspect-name', text: n.name })
    ])
  )
  if (n.sig) host.append(el('pre', { class: 'brain-inspect-sig', text: n.sig }))
  if (!n.dangling) {
    host.append(
      el('button', {
        class: 'brain-inspect-file',
        type: 'button',
        title: isMem ? 'Open in the reader' : 'Reveal in the explorer',
        text: `${n.file}:${n.startLine}`,
        onClick: () => (isMem && slug ? deps.onRead(slug) : deps.onReveal(n))
      })
    )
  }
  if (n.root) host.append(el('p', { class: 'brain-inspect-root', text: n.root, title: 'checkout' }))

  const actions = el('div', { class: 'brain-inspect-actions' }, [
    n.ring !== 0
      ? Button({ label: 'Focus here', variant: 'outline', size: 'sm', onClick: () => deps.onFocus(n) })
      : null,
    isMem && slug && !n.dangling
      ? Button({ label: 'Read', variant: 'primary', size: 'sm', onClick: () => deps.onRead(slug) })
      : null,
    !isMem ? Button({ label: 'Reveal in explorer', variant: 'outline', size: 'sm', onClick: () => deps.onReveal(n) }) : null
  ])
  host.append(actions)

  if (model.neighbors.length) {
    host.append(
      el('h3', {
        class: 'brain-inspect-sub',
        text: `Neighbors (${model.neighbors.length}${model.neighborsTruncated ? '+' : ''})`
      }),
      el(
        'ul',
        { class: 'brain-inspect-list' },
        model.neighbors.map((entry) =>
          el('li', {}, [
            el(
              'button',
              {
                class: 'brain-inspect-neighbor',
                type: 'button',
                title: `${entry.edge.kind} · ${entry.edge.direction}`,
                onClick: () =>
                  deps.onFocus({
                    id: entry.node.id,
                    kind: entry.node.kind,
                    name: entry.node.name,
                    file: entry.node.file,
                    startLine: entry.node.startLine,
                    sig: entry.node.sig,
                    ...(entry.node.root ? { root: entry.node.root } : {}),
                    ring: 1,
                    x: 0,
                    y: 0
                  })
              },
              [
                el('span', { class: `brain-edge-chip is-${entry.edge.kind}`, text: entry.edge.kind }),
                el('span', { class: 'brain-inspect-neighbor-name', text: entry.node.name })
              ]
            )
          ])
        )
      )
    )
  }
}
