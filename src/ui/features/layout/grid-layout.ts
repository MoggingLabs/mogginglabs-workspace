import type { PaneId } from '@contracts'
import { publishSlots, clearSlots, type LayoutSlot } from '../../core/layout/slots'
import { TEMPLATES, type GridSpec } from './templates'

const GUTTER = 6 // px between tracks (the drag handle)
const MIN_FR = 0.15 // don't let a track collapse below this

/**
 * A resizable CSS-grid of terminal SLOTS. Owns the grid DOM, the drag-resize gutters, and
 * focus tracking; publishes its slots for the terminal feature to fill. Slot elements are
 * REUSED across template changes (keyed by pane id), so a pane stays mounted (its PTY isn't
 * killed) when you switch templates — only added/removed panes change.
 */
export class GridLayout {
  private readonly grid: HTMLElement
  private count = 1
  private colFrs: number[] = [1]
  private rowFrs: number[] = [1]
  private readonly slotEls = new Map<number, HTMLElement>()

  constructor(
    host: HTMLElement,
    private readonly source: string,
    private readonly baseId = 0
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
    this.apply(1)
  }

  get paneCount(): number {
    return this.count
  }

  /** Apply an N-pane grid template (1/2/4/6/8/9/12/16). Rebuilds slots + publishes them. */
  apply(n: number): void {
    const spec = TEMPLATES[n]
    if (!spec) return
    this.count = n
    this.colFrs = Array<number>(spec.cols).fill(1)
    this.rowFrs = Array<number>(spec.rows).fill(1)
    this.rebuild(spec)
  }

  private ensureSlot(id: number): HTMLElement {
    let el = this.slotEls.get(id)
    if (!el) {
      el = document.createElement('div')
      el.className = 'layout-slot'
      el.dataset.paneId = String(id)
      this.slotEls.set(id, el)
    }
    return el
  }

  private rebuild(spec: GridSpec): void {
    const n = spec.rows * spec.cols
    for (const [id, el] of this.slotEls) {
      if (id > n) {
        el.remove()
        this.slotEls.delete(id)
      }
    }
    for (const g of Array.from(this.grid.querySelectorAll('.layout-gutter'))) g.remove()

    this.grid.style.gridTemplateColumns = this.trackList(this.colFrs)
    this.grid.style.gridTemplateRows = this.trackList(this.rowFrs)

    const slots: LayoutSlot[] = []
    let id = 1
    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c < spec.cols; c++) {
        const el = this.ensureSlot(id)
        el.dataset.paneId = String(this.baseId + id)
        el.style.gridColumn = String(2 * c + 1)
        el.style.gridRow = String(2 * r + 1)
        if (el.parentElement !== this.grid) this.grid.append(el)
        slots.push({ id: (this.baseId + id) as PaneId, el })
        id++
      }
    }
    for (let c = 1; c < spec.cols; c++) this.grid.append(this.makeGutter('vertical', c, spec))
    for (let r = 1; r < spec.rows; r++) this.grid.append(this.makeGutter('horizontal', r, spec))

    if (!this.grid.querySelector('.layout-slot.focused')) {
      const first = this.slotEls.get(1)
      if (first) this.setFocused(first)
    }
    publishSlots(this.source, slots)
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
  }

  /** Tear down: clear this source's slots (terminal disposes its panes) + remove the grid. */
  dispose(): void {
    clearSlots(this.source)
    this.grid.remove()
  }
}
