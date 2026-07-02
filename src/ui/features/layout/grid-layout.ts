import type { PaneId } from '@contracts'
import { publishSlots, clearSlots, type LayoutSlot } from '../../core/layout/slots'
import { getTelemetry } from '../../core/telemetry'
import { TEMPLATES, type GridSpec } from './templates'

const GUTTER = 2 // px between tracks — with each pane's 1px border: a 4px seam, matching the app edge
const MIN_FR = 0.15 // don't let a track collapse below this
const RAGGED_COLS = 12 // LCM of 1..4 — lets any last-row remainder span evenly

export type ExpandMode = 'full' | 'col' | 'row'

interface Placement {
  row: number
  colStart: number // in cell units (not tracks)
  colEnd: number
}

/**
 * A resizable CSS-grid of terminal SLOTS. Owns the grid DOM, drag-resize gutters,
 * focus tracking, per-pane EXPAND modes (full workspace / full height / full width —
 * covered siblings hide and release WebGL via the managed leasing), and per-pane CLOSE
 * (the slot leaves the grid, its PTY is disposed through the slots port, and the
 * remaining panes reflow — uniform template grids keep drag-gutters; ragged counts
 * lay out on an LCM-12 grid with even last-row spans). Slot elements are REUSED across
 * template changes (keyed by pane id) so a pane stays mounted when the grid changes.
 */
export class GridLayout {
  private readonly grid: HTMLElement
  private activeIds: number[] = [1]
  private cols = 1
  private colFrs: number[] = [1]
  private rowFrs: number[] = [1]
  private expandedId: number | null = null
  private expandMode: ExpandMode | null = null
  private readonly placements = new Map<number, Placement>()
  private readonly slotEls = new Map<number, HTMLElement>()

  constructor(
    host: HTMLElement,
    private readonly source: string,
    private readonly baseId = 0,
    private readonly onFocus?: (paneId: PaneId) => void
  ) {
    this.grid = document.createElement('div')
    this.grid.className = 'layout-grid'
    host.append(this.grid)
    this.grid.addEventListener('mousedown', (e) => {
      const slot = (e.target as HTMLElement).closest('.layout-slot') as HTMLElement | null
      if (slot) this.setFocused(slot)
    })
    this.grid.addEventListener('focusin', () => {
      const slot = (document.activeElement as HTMLElement | null)?.closest?.('.layout-slot') as HTMLElement | null
      if (slot) this.setFocused(slot)
    })
    // Pane headers ask for zoom/expand via bubbling DOM events (terminal ⇢ layout stays decoupled).
    this.grid.addEventListener('mogging:zoom-pane', (e) => {
      const paneId = (e as CustomEvent<{ paneId: number }>).detail?.paneId
      this.toggleExpand(paneId, 'full')
    })
    this.grid.addEventListener('mogging:expand-pane', (e) => {
      const d = (e as CustomEvent<{ paneId: number; mode: ExpandMode }>).detail
      if (d) this.toggleExpand(d.paneId, d.mode)
    })
    this.apply(1)
  }

  get paneCount(): number {
    return this.activeIds.length
  }

  /** Live pane ids (closed slots excluded) — the source of truth for attention scans. */
  paneIds(): PaneId[] {
    return this.activeIds.map((id) => (this.baseId + id) as PaneId)
  }

  /** Column count for a pane count: the curated template shape, else near-square. */
  private shapeFor(n: number): GridSpec {
    const spec = TEMPLATES[n]
    if (spec) return spec
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))))
    return { cols, rows: Math.ceil(n / cols) }
  }

  /** Apply an N-pane grid (any 1..16; template counts keep their curated shapes).
   *  Rebuilds slots + publishes them. */
  apply(n: number): void {
    const count = Math.max(1, Math.min(16, Math.floor(n)))
    this.activeIds = Array.from({ length: count }, (_, i) => i + 1)
    this.clearExpand()
    const spec = this.shapeFor(count)
    this.cols = spec.cols
    this.colFrs = Array<number>(spec.cols).fill(1)
    this.rowFrs = Array<number>(spec.rows).fill(1)
    this.rebuild()
  }

  /** Close one pane: its slot leaves the grid (the slots port disposes its terminal +
   *  PTY) and the remaining panes reflow. The caller guards the last-pane case. */
  closePane(paneId: number): void {
    const localId = paneId - this.baseId
    if (!this.activeIds.includes(localId) || this.activeIds.length <= 1) return
    this.clearExpand()
    const el = this.slotEls.get(localId)
    el?.remove()
    this.slotEls.delete(localId)
    this.activeIds = this.activeIds.filter((id) => id !== localId)
    const spec = this.shapeFor(this.activeIds.length)
    this.cols = spec.cols
    this.colFrs = Array<number>(spec.cols).fill(1)
    this.rowFrs = Array<number>(Math.ceil(this.activeIds.length / spec.cols)).fill(1)
    this.rebuild()
  }

  private ensureSlot(id: number): HTMLElement {
    let el = this.slotEls.get(id)
    if (!el) {
      el = document.createElement('div')
      el.className = 'layout-slot'
      el.dataset.paneId = String(this.baseId + id) // global pane id — smoke-asserted selector
      this.slotEls.set(id, el)
    }
    return el
  }

  /** True when every row is full (lets the grid keep exact tracks + drag gutters). */
  private isUniform(): boolean {
    return this.activeIds.length % this.cols === 0
  }

  private rebuild(): void {
    // Drop slots that are no longer active (template shrink) — their panes dispose.
    for (const [id, el] of this.slotEls) {
      if (!this.activeIds.includes(id)) {
        el.remove()
        this.slotEls.delete(id)
      }
    }
    for (const g of Array.from(this.grid.querySelectorAll('.layout-gutter'))) g.remove()
    this.placements.clear()
    this.grid.classList.remove('has-expand')

    const rows: number[][] = []
    for (let i = 0; i < this.activeIds.length; i += this.cols) {
      rows.push(this.activeIds.slice(i, i + this.cols))
    }
    const uniform = this.isUniform()
    const slots: LayoutSlot[] = []

    if (uniform) {
      // Exact tracks with draggable gutter tracks between them.
      this.grid.style.gap = ''
      this.grid.style.gridTemplateColumns = this.trackList(this.colFrs)
      this.grid.style.gridTemplateRows = this.trackList(this.rowFrs)
      rows.forEach((rowIds, r) => {
        rowIds.forEach((id, c) => {
          const el = this.ensureSlot(id)
          el.classList.remove('expanded', 'covered')
          el.style.gridColumn = String(2 * c + 1)
          el.style.gridRow = String(2 * r + 1)
          if (el.parentElement !== this.grid) this.grid.append(el)
          this.placements.set(id, { row: r, colStart: c, colEnd: c + 1 })
          slots.push({ id: (this.baseId + id) as PaneId, el })
        })
      })
      const spec: GridSpec = { rows: rows.length, cols: this.cols }
      for (let c = 1; c < spec.cols; c++) this.grid.append(this.makeGutter('vertical', c, spec))
      for (let r = 1; r < spec.rows; r++) this.grid.append(this.makeGutter('horizontal', r, spec))
    } else {
      // Ragged count: an LCM-12 column grid; each row's panes span it evenly.
      // (Drag-resize pauses for ragged layouts — re-apply a template to get it back.)
      this.grid.style.gap = `${GUTTER}px`
      this.grid.style.gridTemplateColumns = `repeat(${RAGGED_COLS}, 1fr)`
      this.grid.style.gridTemplateRows = `repeat(${rows.length}, 1fr)`
      rows.forEach((rowIds, r) => {
        const span = RAGGED_COLS / rowIds.length
        rowIds.forEach((id, c) => {
          const el = this.ensureSlot(id)
          el.classList.remove('expanded', 'covered')
          el.style.gridColumn = `${c * span + 1} / span ${span}`
          el.style.gridRow = String(r + 1)
          if (el.parentElement !== this.grid) this.grid.append(el)
          this.placements.set(id, {
            row: r,
            colStart: (c * span) / span, // cell index within its row
            colEnd: (c * span) / span + 1
          })
          slots.push({ id: (this.baseId + id) as PaneId, el })
        })
      })
    }

    if (!this.grid.querySelector('.layout-slot.focused')) {
      const first = this.slotEls.get(this.activeIds[0])
      if (first) this.setFocused(first)
    }
    publishSlots(this.source, slots)
  }

  /** Zoom/expand a pane — 'full' = the whole workspace, 'col' = full height (own
   *  width), 'row' = full width (own height). Covered siblings hide (and release
   *  WebGL via the managed leasing); toggling the same mode restores the grid. */
  toggleExpand(paneId?: number, mode: ExpandMode = 'full'): void {
    const target = paneId ?? this.focusedPaneId() ?? undefined
    if (target == null) return
    const localId = target - this.baseId
    const slot = this.slotEls.get(localId)
    if (!slot) return

    const wasMode = this.expandedId === localId ? this.expandMode : null
    this.clearExpand()
    if (wasMode === mode) {
      // Same control toggled again -> plain grid restored.
      this.rebuild()
      this.setFocused(slot)
      getTelemetry().captureEvent({ name: 'pane.expanded', props: { mode, on: false } })
      return
    }
    getTelemetry().captureEvent({ name: 'pane.expanded', props: { mode, on: true } })

    this.rebuild() // normalize placements before overriding the target's
    this.expandedId = localId
    this.expandMode = mode
    const mine = this.placements.get(localId)
    slot.classList.add('expanded')
    this.grid.classList.add('has-expand')

    for (const [id, el] of this.slotEls) {
      if (id === localId) continue
      const p = this.placements.get(id)
      if (!p || !mine) continue
      const covered =
        mode === 'full' ||
        (mode === 'col' && this.sameColumn(mine, p)) ||
        (mode === 'row' && p.row === mine.row)
      el.classList.toggle('covered', covered)
    }

    if (mode === 'full') {
      slot.style.gridArea = '1 / 1 / -1 / -1'
    } else if (mode === 'col') {
      slot.style.gridRow = '1 / -1' // full height; keeps its column placement
    } else {
      slot.style.gridColumn = '1 / -1' // full width; keeps its row
    }
    this.setFocused(slot)
  }

  /** Do two placements share horizontal space (same column lane)? Uniform grids have
   *  exact lanes; ragged rows compare by proportional overlap of row position. */
  private sameColumn(a: Placement, b: Placement): boolean {
    if (this.isUniform()) return a.colStart === b.colStart
    // Ragged rows have different widths per row — treat overlapping row-relative
    // positions as the same lane so a full-height pane never underlaps a hidden one.
    return true
  }

  private clearExpand(): void {
    if (this.expandedId != null) {
      const el = this.slotEls.get(this.expandedId)
      el?.classList.remove('expanded')
      el?.style.removeProperty('grid-area')
    }
    this.expandedId = null
    this.expandMode = null
    this.grid.classList.remove('has-expand')
    for (const el of this.slotEls.values()) el.classList.remove('covered')
  }

  /** Legacy alias (keyboard Ctrl+Shift+Enter, dev handle): full-workspace zoom. */
  toggleZoom(paneId?: number): void {
    this.toggleExpand(paneId, 'full')
  }

  /** Focus a specific pane by global id (control API / cross-feature callers). */
  focusPane(paneId: number): void {
    const el = this.slotEls.get(paneId - this.baseId)
    if (el) this.setFocused(el)
  }

  /** Move focus to the neighboring pane in a direction (keyboard pane nav). */
  focusDir(dir: 'left' | 'right' | 'up' | 'down'): void {
    const focused = this.focusedPaneId()
    const local = focused != null ? focused - this.baseId : this.activeIds[0]
    const index = this.activeIds.indexOf(local)
    if (index < 0) return
    const row = Math.floor(index / this.cols)
    const col = index % this.cols
    const next = {
      left: { row, col: col - 1 },
      right: { row, col: col + 1 },
      up: { row: row - 1, col },
      down: { row: row + 1, col }
    }[dir]
    const rowsTotal = Math.ceil(this.activeIds.length / this.cols)
    if (next.row < 0 || next.row >= rowsTotal || next.col < 0 || next.col >= this.cols) return
    const targetIndex = next.row * this.cols + next.col
    const targetId = this.activeIds[targetIndex]
    const slot = targetId != null ? this.slotEls.get(targetId) : undefined
    if (slot) this.setFocused(slot)
  }

  private trackList(frs: number[]): string {
    return frs.map((f) => `${f}fr`).join(` ${GUTTER}px `)
  }

  private makeGutter(dir: 'vertical' | 'horizontal', index: number, spec: GridSpec): HTMLElement {
    const g = document.createElement('div')
    g.className = `layout-gutter ${dir}`
    if (dir === 'vertical') {
      g.style.gridColumn = String(2 * index)
      g.style.gridRow = `1 / ${2 * spec.rows}`
    } else {
      g.style.gridRow = String(2 * index)
      g.style.gridColumn = `1 / ${2 * spec.cols}`
    }
    g.addEventListener('mousedown', (e) => this.startDrag(e, dir, index))
    return g
  }

  private startDrag(e: MouseEvent, dir: 'vertical' | 'horizontal', index: number): void {
    e.preventDefault()
    const rect = this.grid.getBoundingClientRect()
    const frs = dir === 'vertical' ? this.colFrs : this.rowFrs
    const totalPx = dir === 'vertical' ? rect.width : rect.height
    const totalFr = frs.reduce((s, f) => s + f, 0)
    const startPos = dir === 'vertical' ? e.clientX : e.clientY
    const a = frs[index - 1]
    const b = frs[index]
    const sum = a + b
    const move = (ev: MouseEvent): void => {
      const pos = dir === 'vertical' ? ev.clientX : ev.clientY
      const deltaFr = ((pos - startPos) / totalPx) * totalFr
      let na = a + deltaFr
      let nb = b - deltaFr
      if (na < MIN_FR) {
        na = MIN_FR
        nb = sum - MIN_FR
      }
      if (nb < MIN_FR) {
        nb = MIN_FR
        na = sum - MIN_FR
      }
      frs[index - 1] = na
      frs[index] = nb
      if (dir === 'vertical') this.grid.style.gridTemplateColumns = this.trackList(this.colFrs)
      else this.grid.style.gridTemplateRows = this.trackList(this.rowFrs)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private setFocused(slot: HTMLElement): void {
    for (const s of Array.from(this.grid.querySelectorAll('.layout-slot'))) s.classList.remove('focused')
    slot.classList.add('focused')
    const paneId = Number(slot.dataset.paneId)
    if (paneId) this.onFocus?.(paneId as PaneId)
  }

  /** The pane id of the currently-focused slot (there is always one after apply). */
  focusedPaneId(): PaneId | null {
    const el = this.grid.querySelector('.layout-slot.focused') as HTMLElement | null
    return el ? (Number(el.dataset.paneId) as PaneId) : null
  }

  /** Tear down: clear this source's slots (terminal disposes its panes) + remove the grid. */
  dispose(): void {
    clearSlots(this.source)
    this.grid.remove()
  }
}
