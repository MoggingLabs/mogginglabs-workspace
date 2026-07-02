import { el } from './dom'

export interface GridPreviewOpts {
  rows: number
  cols: number
  /** Optional per-tile provider ids, slot order (length rows*cols). 'shell' /
   *  null / undefined render as an empty terminal tile. */
  assignments?: (string | null | undefined)[]
  providerColor?: (id: string) => string
  providerInitial?: (id: string) => string
}

/**
 * A true-to-shape miniature of a grid. Used by the wizard's layout tiles and the
 * agent-assignment preview ("which tile gets which agent").
 */
export function MiniGridPreview(opts: GridPreviewOpts): HTMLElement {
  const grid = el('div', {
    class: 'grid-preview',
    attrs: { 'aria-hidden': 'true' },
    style: {
      gridTemplateColumns: `repeat(${opts.cols}, 1fr)`,
      gridTemplateRows: `repeat(${opts.rows}, 1fr)`
    }
  })
  const total = opts.rows * opts.cols
  for (let i = 0; i < total; i++) {
    const cell = el('div', { class: 'grid-preview-cell' })
    const assigned = opts.assignments?.[i]
    if (assigned && assigned !== 'shell') {
      cell.classList.add('is-filled')
      cell.style.setProperty('--cell-accent', opts.providerColor?.(assigned) ?? 'var(--accent)')
      cell.append(
        el('span', {
          class: 'grid-preview-chip',
          text: (opts.providerInitial?.(assigned) ?? assigned).slice(0, 1).toUpperCase()
        })
      )
    }
    grid.append(cell)
  }
  return grid
}

export interface LayoutSpec {
  count: number
  rows: number
  cols: number
}

export interface LayoutGridPickerHandle {
  el: HTMLElement
  selected(): number
  setSelected(count: number): void
}

/**
 * "How many terminals?" — a row of tiles, each a live miniature of its grid shape.
 * Radio semantics; arrow keys move the selection.
 */
export function createLayoutGridPicker(opts: {
  specs: LayoutSpec[]
  selected: number
  onSelect: (count: number) => void
}): LayoutGridPickerHandle {
  let selected = opts.selected
  const tiles = new Map<number, HTMLButtonElement>()

  function apply(count: number, fire: boolean): void {
    selected = count
    for (const [c, tile] of tiles) {
      tile.classList.toggle('is-selected', c === count)
      tile.setAttribute('aria-checked', String(c === count))
      tile.tabIndex = c === count ? 0 : -1
    }
    if (fire) opts.onSelect(count)
  }

  const root = el('div', {
    class: 'layout-picker',
    role: 'radiogroup',
    ariaLabel: 'How many terminals',
    onKeydown: (e) => {
      const order = opts.specs.map((s) => s.count)
      const i = order.indexOf(selected)
      let next: number | undefined
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[i + 1]
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = order[i - 1]
      if (next != null) {
        e.preventDefault()
        apply(next, true)
        tiles.get(next)?.focus()
      }
    }
  })

  for (const spec of opts.specs) {
    const tile = el(
      'button',
      {
        class: 'layout-tile',
        type: 'button',
        role: 'radio',
        ariaLabel: `${spec.count} ${spec.count === 1 ? 'terminal' : 'terminals'} (${spec.rows}×${spec.cols})`,
        onClick: () => apply(spec.count, true)
      },
      [
        MiniGridPreview({ rows: spec.rows, cols: spec.cols }),
        el('span', { class: 'layout-tile-count', text: String(spec.count) })
      ]
    )
    tiles.set(spec.count, tile)
    root.append(tile)
  }
  apply(selected, false)

  return { el: root, selected: () => selected, setSelected: (c) => apply(c, false) }
}
