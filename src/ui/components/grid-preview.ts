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

// The titlebar layout popover's tile picker (createLayoutGridPicker) lived here until
// the reorganize redesign retired it: the popover is counter-driven now (two stepper
// rows + Reorganize), so nothing pins a pane COUNT via tiles any more. The wizard's
// "how many terminals" step uses the interactive lattice painter (grid-painter.ts),
// never this; MiniGridPreview stays as the shared true-to-shape miniature (wizard
// assignment preview + the popover's Reorganize mark).
