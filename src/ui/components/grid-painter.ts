import {
  expandToWholeRegions,
  mergeRegions,
  uniformSpec,
  unmergeRegion,
  type GridSpecModel
} from '../features/layout/grid-regions'
import { el } from './dom'

/**
 * The dynamic layout painter (wizard revamp): two surfaces, one gesture each.
 *
 *   SIZE — a Word-style insert-table lattice. Hovering cell (r,c) previews an
 *   r×c grid; click (or drag and release) commits it. No presets — any rows ×
 *   cols up to the pane cap.
 *
 *   SHAPE — the committed grid drawn large, one tile per terminal. Dragging
 *   across tiles selects a rectangle and MERGES it into one spanning terminal
 *   (the selection grows to swallow whole tiles, Excel's rule). Clicking a
 *   merged tile splits it back. A merge whose result the split-tree engine
 *   could not build (no straight cut — pinwheels) previews as refused and
 *   never commits, so the painter can only show buildable layouts.
 *
 * The SHAPE surface doubles as the live assignment preview: the wizard feeds
 * `slotChip` and each tile wears its terminal's provider mark. One surface for
 * "how many, in what arrangement, running what" — the three questions the old
 * tile row + separate preview split across the page.
 */

export interface GridPainterOpts {
  value: GridSpecModel
  /** Lattice bounds (default 4×5) and the hard pane cap (default 16). */
  maxRows?: number
  maxCols?: number
  maxPanes?: number
  onChange: (spec: GridSpecModel) => void
  /** Chip content for slot k (0-based, reading order); null = plain shell tile. */
  slotChip?: (slot: number) => { color: string; mark: HTMLElement | null; label: string } | null
  /**
   * PAINT MODE (the agent-placement redesign). When this returns non-null, a brush is
   * armed: press/drag on the canvas PAINTS terminals (onPaint per slot) instead of
   * merging, and the merge preview stays out of the way. When null, the canvas keeps its
   * structural gestures exactly as before — drag merges, a click on a merged tile splits
   * — and a plain click on an UNMERGED tile asks the host to open its picker
   * (onPickSlot). The two modes never overlap, which is what makes each learnable.
   */
  brush?: () => string | null
  /** Paint `slot` with the armed brush. Fired live, per tile, as the pointer crosses it. */
  onPaint?: (slot: number) => void
  /** A plain no-brush click (or Enter) on an unmerged tile — open the per-terminal picker. */
  onPickSlot?: (slot: number, anchor: DOMRect) => void
}

export interface GridPainterHandle {
  el: HTMLElement
  set(spec: GridSpecModel): void
  value(): GridSpecModel
  /** Re-render tile chips (the mix changed but the shape did not). */
  refreshChips(): void
  /** Dev/smoke handle: merge by cell rect, exactly as the drag would. */
  mergeRect(r0: number, c0: number, r1: number, c1: number): boolean
}

export function createGridPainter(opts: GridPainterOpts): GridPainterHandle {
  const maxRows = opts.maxRows ?? 4
  const maxCols = opts.maxCols ?? 5
  const maxPanes = opts.maxPanes ?? 16
  let spec = opts.value

  const root = el('div', { class: 'grid-painter' })
  const lattice = el('div', { class: 'gp-lattice', role: 'group', ariaLabel: 'Grid size — drag to choose rows by columns' })
  lattice.style.gridTemplateColumns = `repeat(${maxCols}, 1fr)`
  const canvas = el('div', { class: 'gp-canvas', role: 'group', ariaLabel: 'Layout — drag across terminals to merge them' })
  root.append(lattice, canvas)

  // ── SIZE lattice ──────────────────────────────────────────────────────────
  const cells: HTMLButtonElement[] = []
  const paintHover = (rows: number, cols: number): void => {
    cells.forEach((cell) => {
      const r = Number(cell.dataset.r)
      const c = Number(cell.dataset.c)
      cell.classList.toggle('is-hot', rows > 0 && r < rows && c < cols)
    })
  }
  const paintActive = (): void => {
    cells.forEach((cell) => {
      const r = Number(cell.dataset.r)
      const c = Number(cell.dataset.c)
      cell.classList.toggle('is-active', r < spec.rows && c < spec.cols)
    })
  }
  const commitSize = (r: number, c: number): void => {
    if ((r + 1) * (c + 1) > maxPanes) return
    spec = uniformSpec(r + 1, c + 1)
    render()
    opts.onChange(spec)
  }
  interface SizeDrag {
    r: number
    c: number
    valid: boolean
  }
  let sizeDrag: SizeDrag | null = null
  let suppressClick = false
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) {
      const panes = (r + 1) * (c + 1)
      const blocked = panes > maxPanes
      const cell = el('button', {
        class: 'gp-cell' + (blocked ? ' is-blocked' : ''),
        type: 'button',
        title: blocked ? `${panes} — max ${maxPanes} terminals` : `${r + 1}×${c + 1} — ${panes} ${panes === 1 ? 'terminal' : 'terminals'}`,
        ariaLabel: blocked ? `${r + 1} by ${c + 1} — over the ${maxPanes}-terminal cap` : `${r + 1} by ${c + 1} grid, ${panes} terminals`
      }) as HTMLButtonElement
      cell.dataset.r = String(r)
      cell.dataset.c = String(c)
      if (blocked) cell.disabled = true
      cell.addEventListener('pointerenter', () => {
        if (!blocked) paintHover(r + 1, c + 1)
      })
      // Keyboard commits land here (Enter/Space on the focused cell). Pointer commits
      // land on the lattice's pointerup below — which then swallows the click this
      // very gesture synthesizes, or a plain click would commit twice.
      cell.addEventListener('click', () => {
        if (blocked) return
        if (suppressClick) {
          suppressClick = false
          return
        }
        commitSize(r, c)
      })
      cells.push(cell)
      lattice.append(cell)
    }
  }

  // The insert-table gesture is PRESS, sweep, RELEASE — not only a click. The old
  // lattice listened per-cell for `click`, and a press on (0,0) released over (0,7)
  // fires no click on either cell: the user "selected eight across" and nothing
  // happened. Pointer coordinates (the canvas's cellAt approach) rather than event
  // targets, because blocked cells are disabled buttons and swallow their events.
  const latticeCellAt = (event: PointerEvent): { r: number; c: number } | null => {
    const box = lattice.getBoundingClientRect()
    if (!box.width || !box.height) return null
    if (
      event.clientX < box.x - 1 ||
      event.clientX > box.x + box.width + 1 ||
      event.clientY < box.y - 1 ||
      event.clientY > box.y + box.height + 1
    ) {
      return null // released off the lattice: the gesture is a cancel, not a commit
    }
    const x = Math.min(Math.max(event.clientX - box.x, 0), box.width - 1)
    const y = Math.min(Math.max(event.clientY - box.y, 0), box.height - 1)
    return {
      r: Math.min(maxRows - 1, Math.floor((y / box.height) * maxRows)),
      c: Math.min(maxCols - 1, Math.floor((x / box.width) * maxCols))
    }
  }
  const trackSizeDrag = (event: PointerEvent): void => {
    const cell = latticeCellAt(event)
    if (!cell || !sizeDrag) return
    sizeDrag = { ...cell, valid: (cell.r + 1) * (cell.c + 1) <= maxPanes }
    if (sizeDrag.valid) paintHover(cell.r + 1, cell.c + 1)
  }
  lattice.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    sizeDrag = { r: 0, c: 0, valid: false }
    trackSizeDrag(event)
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointerup', up)
      const drag = sizeDrag
      sizeDrag = null
      const cell = latticeCellAt(ev)
      if (!cell || !drag) return // released elsewhere: nothing committed
      suppressClick = true // the same-cell click this gesture synthesizes is not a second commit
      setTimeout(() => (suppressClick = false), 0) // …but a LATER keyboard click is
      commitSize(cell.r, cell.c)
    }
    window.addEventListener('pointerup', up)
  })
  lattice.addEventListener('pointermove', (event) => {
    if (sizeDrag) trackSizeDrag(event)
  })
  lattice.addEventListener('pointerleave', () => paintHover(0, 0))

  // ── SHAPE canvas (merge / unmerge / paint / live chips) ───────────────────
  interface DragState {
    anchor: { r: number; c: number }
    current: { r: number; c: number }
    moved: boolean
  }
  let drag: DragState | null = null
  /** Slots painted by the CURRENT gesture — each fires onPaint once per pass, so
   *  wobbling the pointer inside one tile cannot spam the host. */
  let paintDrag: Set<number> | null = null

  /** The region (terminal) index a grid cell belongs to. */
  const regionAt = (cell: { r: number; c: number }): number =>
    spec.regions.findIndex(
      (region) =>
        cell.r >= region.r && cell.r < region.r + region.rs && cell.c >= region.c && cell.c < region.c + region.cs
    )

  const cellAt = (event: PointerEvent): { r: number; c: number } | null => {
    const box = canvas.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const x = Math.min(Math.max(event.clientX - box.x, 0), box.width - 1)
    const y = Math.min(Math.max(event.clientY - box.y, 0), box.height - 1)
    return {
      r: Math.min(spec.rows - 1, Math.floor((y / box.height) * spec.rows)),
      c: Math.min(spec.cols - 1, Math.floor((x / box.width) * spec.cols))
    }
  }

  const paintMergePreview = (): void => {
    const tiles = [...canvas.querySelectorAll<HTMLElement>('.gp-region')]
    if (!drag || !drag.moved) {
      tiles.forEach((tile) => tile.classList.remove('is-merge-preview', 'is-merge-invalid'))
      return
    }
    const box = expandToWholeRegions(spec, {
      r0: drag.anchor.r,
      c0: drag.anchor.c,
      r1: drag.current.r,
      c1: drag.current.c
    })
    const valid =
      mergeRegions(spec, { r0: drag.anchor.r, c0: drag.anchor.c, r1: drag.current.r, c1: drag.current.c }) !== null
    tiles.forEach((tile, i) => {
      const region = spec.regions[i]!
      const inside =
        region.r >= box.r0 && region.c >= box.c0 && region.r + region.rs - 1 <= box.r1 && region.c + region.cs - 1 <= box.c1
      tile.classList.toggle('is-merge-preview', inside && valid)
      tile.classList.toggle('is-merge-invalid', inside && !valid)
    })
  }

  /** Paint the region under the pointer, once per gesture pass. Live — the tile takes its
   *  chip while the pointer is still moving, which is what makes a sweep feel like a
   *  brushstroke instead of a form submit. */
  const paintAt = (event: PointerEvent): void => {
    if (!paintDrag) return
    const cell = cellAt(event)
    if (!cell) return
    const index = regionAt(cell)
    if (index < 0 || paintDrag.has(index)) return
    paintDrag.add(index)
    opts.onPaint?.(index)
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const cell = cellAt(event)
    if (!cell) return
    // A brush is armed: this gesture PAINTS. Structural gestures wait until the brush is
    // put down — overloading one drag with both meanings would make each unlearnable.
    if (opts.brush?.()) {
      paintDrag = new Set()
      paintAt(event)
    } else {
      drag = { anchor: cell, current: cell, moved: false }
    }
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic pointers (gates) have no active id to capture — the move/up
         listeners are on the canvas itself, so the drag still tracks */
    }
  })
  canvas.addEventListener('pointermove', (event) => {
    if (paintDrag) return paintAt(event)
    if (!drag) return
    const cell = cellAt(event)
    if (!cell) return
    if (cell.r !== drag.anchor.r || cell.c !== drag.anchor.c) drag.moved = true
    drag.current = cell
    paintMergePreview()
  })
  const endDrag = (commit: boolean): void => {
    if (paintDrag) {
      paintDrag = null
      return
    }
    if (!drag) return
    const state = drag
    drag = null
    paintMergePreview()
    if (!commit) return
    if (state.moved) {
      const merged = mergeRegions(spec, {
        r0: state.anchor.r,
        c0: state.anchor.c,
        r1: state.current.r,
        c1: state.current.c
      })
      if (merged) {
        spec = merged
        render()
        opts.onChange(spec)
      } else {
        canvas.classList.remove('gp-shake')
        void canvas.offsetWidth // restart the refusal nudge
        canvas.classList.add('gp-shake')
      }
      return
    }
    // A plain click, no brush armed: a merged tile splits back apart (the structural
    // affordance the gates pin); an unmerged tile opens ITS OWN picker — the click-to-
    // pick half of the placement model, for whoever never discovers the brush.
    const index = regionAt(state.anchor)
    const region = spec.regions[index]
    if (!region) return
    if (region.rs > 1 || region.cs > 1) {
      spec = unmergeRegion(spec, index)
      render()
      opts.onChange(spec)
    } else if (opts.onPickSlot) {
      const tile = canvas.querySelectorAll<HTMLElement>('.gp-region')[index]
      if (tile) opts.onPickSlot(index, tile.getBoundingClientRect())
    }
  }
  canvas.addEventListener('pointerup', () => endDrag(true))
  canvas.addEventListener('pointercancel', () => endDrag(false))

  const render = (): void => {
    paintActive()
    paintHover(0, 0)
    canvas.innerHTML = ''
    // An armed brush changes what a press means — the cursor should say so before the press.
    canvas.classList.toggle('is-painting', !!opts.brush?.())
    canvas.style.gridTemplateRows = `repeat(${spec.rows}, 1fr)`
    canvas.style.gridTemplateColumns = `repeat(${spec.cols}, 1fr)`
    spec.regions.forEach((region, i) => {
      const merged = region.rs > 1 || region.cs > 1
      const chip = opts.slotChip?.(i) ?? null
      const tile = el(
        'button',
        {
          class: 'gp-region' + (merged ? ' is-merged' : ''),
          type: 'button',
          // The tile's tooltip is the placement model's quiet teacher (compact pass): a
          // bare tile says a click will choose, an assigned one says it can change.
          title: merged
            ? 'Merged terminal — click to split it back'
            : chip?.label
              ? `${chip.label} — click to change`
              : 'Click to choose what runs here',
          ariaLabel:
            `Terminal ${i + 1}` +
            (chip ? ` — ${chip.label}` : '') +
            (merged ? ` — spans ${region.rs} by ${region.cs}, press Enter to split` : '')
        },
        [
          chip?.mark ? el('span', { class: 'gp-chip' }, [chip.mark]) : el('span', { class: 'gp-chip gp-chip--shell' }),
          el('span', { class: 'gp-slot', text: chip?.label || `${i + 1}` })
        ]
      ) as HTMLButtonElement
      tile.style.gridArea = `${region.r + 1} / ${region.c + 1} / span ${region.rs} / span ${region.cs}`
      if (chip?.color) tile.style.setProperty('--gp-accent', chip.color)
      // Pointer gestures live on the canvas; the keyboard rides the button itself and
      // mirrors the no-brush click exactly: merged splits, unmerged opens its picker.
      // (With a brush armed, Enter paints — the keyboard's brushstroke.)
      tile.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (opts.brush?.()) return opts.onPaint?.(i)
        if (merged) {
          spec = unmergeRegion(spec, i)
          render()
          opts.onChange(spec)
        } else {
          opts.onPickSlot?.(i, tile.getBoundingClientRect())
        }
      })
      canvas.append(tile)
    })
  }
  render()

  return {
    el: root,
    set(next) {
      spec = next
      render()
    },
    value: () => spec,
    refreshChips: render,
    mergeRect(r0, c0, r1, c1) {
      const merged = mergeRegions(spec, { r0, c0, r1, c1 })
      if (!merged) return false
      spec = merged
      render()
      opts.onChange(spec)
      return true
    }
  }
}
