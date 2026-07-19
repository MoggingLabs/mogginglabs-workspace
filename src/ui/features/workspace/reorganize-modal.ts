import { Button, createGridPainter, createModal, el, type GridPainterHandle } from '../../components'
import type { GridSpecModel } from '../layout'

export interface ReorganizeModalOpts {
  /** The starting layout — the workspace's current pane count in its curated shape. */
  spec: GridSpecModel
  /** Painter bounds = this workspace's real capacity (screen ∧ machine ∧ plan), so
   *  every grid it lets you paint is one the workspace can actually render. */
  maxRows: number
  maxCols: number
  maxPanes: number
  onApply: (spec: GridSpecModel) => void
}

/** "6 terminals · 2×3" / "5 terminals · custom" — the live readout under the painter. */
function shapeLabel(spec: GridSpecModel): string {
  const n = spec.regions.length
  const custom = spec.regions.some((region) => region.rs > 1 || region.cs > 1)
  return `${n} terminal${n === 1 ? '' : 's'} · ${custom ? 'custom' : `${spec.rows}×${spec.cols}`}`
}

/**
 * "Reorganize layout" — the wizard's own layout painter, brought to a LIVE workspace.
 * The user is choosing two things at once: how many terminals, and in what arrangement.
 *   SIZE  — the insert-table lattice picks rows × cols.
 *   SHAPE — dragging across cells merges them into spanning terminals.
 * Apply hands the chosen spec back; the controller preserves every terminal that still
 * fits (its PTY untouched) and confirms before closing any that hold a live agent. This
 * is the "choose a new layout while changing the pane count" tool — the structural
 * counterpart to Balance, which only evens the sizes of the arrangement you already have.
 */
export function openReorganizeModal(opts: ReorganizeModalOpts): void {
  const caption = el('p', { class: 'reorg-caption', text: shapeLabel(opts.spec) })

  const painter: GridPainterHandle = createGridPainter({
    value: opts.spec,
    // Display-clamped like the wizard: a 6K panel should not offer a 40-wide lattice.
    maxRows: Math.min(opts.maxRows, 8),
    maxCols: Math.min(opts.maxCols, 12),
    maxPanes: opts.maxPanes,
    onChange: (spec) => {
      caption.textContent = shapeLabel(spec)
    }
  })

  const modal = createModal({
    title: 'Reorganize layout',
    subtitle: 'Pick the grid size, then drag across cells to merge them. Terminals you already have are kept where they fit.',
    // dialog (content-sized), not wizard: the wizard variant is a fixed 640px flow shell
    // and the painter left a lot of it empty. width overrides the dialog default.
    variant: 'dialog',
    width: 520
  })
  modal.setBody(el('div', { class: 'reorg-body' }, [painter.el, caption]))

  const apply = Button({
    label: 'Apply layout',
    variant: 'primary',
    onClick: () => {
      const spec = painter.value()
      modal.close()
      opts.onApply(spec)
    }
  })
  modal.setFooter(
    el('div', { class: 'confirm-actions' }, [
      Button({ label: 'Cancel', variant: 'ghost', onClick: () => modal.close() }),
      apply
    ])
  )
  modal.open()
}
