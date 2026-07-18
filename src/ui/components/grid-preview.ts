import { el } from './dom'

export interface GridPreviewOpts {
  rows: number
  cols: number
  /** Optional per-tile provider ids, slot order (length rows*cols). 'shell' /
   *  null / undefined render as an empty terminal tile. */
  assignments?: (string | null | undefined)[]
  providerColor?: (id: string) => string
  providerInitial?: (id: string) => string
  /** Optional provider mark for a tile (the wizard passes providerLogo); when it
   *  returns null the initial-letter chip renders as before. */
  providerIcon?: (id: string) => HTMLElement | null
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
      const mark = opts.providerIcon?.(assigned)
      cell.append(
        mark
          ? el('span', { class: 'grid-preview-chip grid-preview-chip--logo' }, [mark])
          : el('span', {
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
  /** Set = the tile is shown but not selectable, and the string says WHY (tooltip +
   *  aria-disabled). The tile stays focusable so the reason is reachable, never a
   *  silent dead button. */
  disabledReason?: string
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
  /** Compact tiles for the dense titlebar dropdown (default: the wizard's full size). */
  compact?: boolean
}): LayoutGridPickerHandle {
  let selected = opts.selected
  const tiles = new Map<number, HTMLButtonElement>()
  const disabled = new Set(opts.specs.filter((s) => s.disabledReason).map((s) => s.count))

  function apply(count: number, fire: boolean): void {
    // A user gesture on a disabled tile does nothing (its title says why). Programmatic
    // setSelected still lands — the CURRENT count may itself be disabled (a screen that
    // shrank under a 12-pane workspace) and must still render as selected.
    if (fire && disabled.has(count)) return
    selected = count
    for (const [c, tile] of tiles) {
      tile.classList.toggle('is-selected', c === count)
      tile.setAttribute('aria-checked', String(c === count))
      tile.tabIndex = c === count ? 0 : -1
    }
    if (fire) opts.onSelect(count)
  }

  const root = el('div', {
    class: 'layout-picker' + (opts.compact ? ' layout-picker--compact' : ''),
    role: 'radiogroup',
    ariaLabel: 'How many terminals',
    onKeydown: (e) => {
      // Arrow keys walk the SELECTABLE tiles only; disabled ones stay mouse-hoverable
      // and Tab-reachable for their reason, but the roving selection skips them.
      const order = opts.specs.map((s) => s.count).filter((c) => !disabled.has(c))
      const i = order.indexOf(selected)
      let next: number | undefined
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i >= 0 ? order[i + 1] : order[0]
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = i >= 0 ? order[i - 1] : order[order.length - 1]
      if (next != null) {
        e.preventDefault()
        apply(next, true)
        tiles.get(next)?.focus()
      }
    }
  })

  for (const spec of opts.specs) {
    const off = disabled.has(spec.count)
    const tile = el(
      'button',
      {
        class: 'layout-tile' + (off ? ' is-disabled' : ''),
        type: 'button',
        role: 'radio',
        // aria-disabled, NOT the native attribute: a natively disabled button falls out
        // of the tab order and (on some platforms) stops hit-testing, taking the reason
        // tooltip with it. The click guard lives in apply().
        title: spec.disabledReason,
        attrs: off ? { 'aria-disabled': 'true' } : undefined,
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
