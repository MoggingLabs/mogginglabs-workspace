import type { PaneId } from '@contracts'
import { publishSlots, clearSlots, type LayoutSlot } from '../../core/layout/slots'
import { acknowledgeFinished } from '../../core/attention/attention-port'
import { getTelemetry } from '../../core/telemetry'
import { TEMPLATES, type GridSpec } from './templates'
import {
  computeLayout,
  isSplit,
  leafCount,
  leafIds,
  moveLeaf,
  moveLeafToRootEdge,
  nodeAtPath,
  normalize,
  removeLeaf,
  serializeTree,
  splitLine,
  swapLeaves,
  treeForGrid,
  type DropEdge,
  type GutterSpec,
  type LayoutTreeNode,
  type Rect,
  type SplitDir
} from './layout-tree'

export { parseTree, leafIds } from './layout-tree'
export type { LayoutTreeNode, SplitDir } from './layout-tree'

const GUTTER = 2 // px between panes — with each pane's 1px border: a 4px seam, matching the app edge
const MIN_PANE_PX = 110 // resize floor — the bar's irreducible chrome (state dot + ⋯ + × +
// tightened gaps + padding, see global.css's collapse ladder) needs 108px; below that the
// × clips off the pane. A pane can be small, never crushed past its own controls.
const DRAG_THRESHOLD = 6 // px of header movement before a click becomes a pane drag
const ROOT_EDGE_PX = 14 // workspace-edge drop band ("make this a full column/row here")

/** WebGL context budget (Chromium caps ~16 live contexts — see the feature README). */
export const MAX_PANES = 16

export type ExpandMode = 'full' | 'col' | 'row'

type DropZone =
  | { kind: 'pane'; targetId: number; edge: DropEdge | 'center' }
  | { kind: 'root'; edge: DropEdge }

/**
 * A resizable SPLIT-TREE of terminal SLOTS (`layout-tree.ts` is the model; this class
 * owns the DOM). Slots are absolutely positioned from the computed tree rects, so a
 * slot element NEVER moves in the DOM — a pane's terminal (and PTY) survives every
 * template change, split, resize and drag (elements are keyed by pane id, exactly as
 * before). Each drag-gutter is one SEAM of one line: dragging it resizes only the two
 * subtrees touching that seam, never a whole row/column of the workspace.
 *
 * Also owns: per-pane EXPAND modes (full workspace / full height / full width —
 * covered siblings hide and release WebGL via the managed leasing), per-pane CLOSE
 * (the line absorbs the space), SPLIT (add a terminal — the receiving line
 * re-equalizes), and drag-to-rearrange (drop on a pane's edge to restructure, on its
 * center to swap, on a workspace edge for a full column/row).
 */
export class GridLayout {
  private readonly grid: HTMLElement
  private root: LayoutTreeNode = { id: 1 }
  private expandedId: number | null = null
  private expandMode: ExpandMode | null = null
  private readonly slotEls = new Map<number, HTMLElement>()
  private readonly gutterEls = new Map<string, HTMLElement>()
  private readonly pulseTimers = new Map<number, number>()
  private leafRects = new Map<number, Rect>()
  private splitRects = new Map<string, Rect>()
  private gutterSpecs: GutterSpec[] = []
  private readonly resizeObs: ResizeObserver
  private dropHint: HTMLElement | null = null

  /** Fired after any user-visible layout mutation (apply/split/close/resize/move) —
   *  the workspace controller persists the serialized tree through it. Assigned
   *  AFTER construction, so the constructor's initial 1-pane apply stays silent. */
  onLayoutChange?: () => void

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
      if (slot) {
        this.setFocused(slot)
        // A CLICK is the acknowledgment that dismisses a sticky finished (green)
        // dot — deliberately here and in keyboard nav (moveFocus), NOT in
        // setFocused: reveal/rebuild/programmatic focus paths also run setFocused,
        // and none of those mean "I looked at this pane" (the flag must survive a
        // workspace switch that happens to auto-focus the finished pane).
        const paneId = Number(slot.dataset.paneId)
        if (paneId) acknowledgeFinished(paneId as PaneId)
      }
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
    this.wirePaneDrag()
    // Geometry is JS-computed px (that is what buys per-seam resizing), so the grid
    // re-derives it whenever its box changes — window resizes, rail collapses, AND the
    // 0→W flip when a hidden workspace is switched to (display:none reports 0).
    this.resizeObs = new ResizeObserver(() => this.reflow())
    this.resizeObs.observe(this.grid)
    this.apply(1)
  }

  get paneCount(): number {
    return leafCount(this.root)
  }

  /** Live pane ids (closed slots excluded) — the source of truth for attention scans. */
  paneIds(): PaneId[] {
    return leafIds(this.root).map((id) => (this.baseId + id) as PaneId)
  }

  /** Column count for a pane count: the curated template shape, else near-square. */
  private shapeFor(n: number): GridSpec {
    const spec = TEMPLATES[n]
    if (spec) return spec
    const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))))
    return { cols, rows: Math.ceil(n / cols) }
  }

  /** Apply an N-pane template grid (any 1..16; template counts keep their curated
   *  shapes). Resets the tree — custom arrangement/sizes yield to the template. */
  apply(n: number): void {
    const count = Math.max(1, Math.min(MAX_PANES, Math.floor(n)))
    const ids = Array.from({ length: count }, (_, i) => i + 1)
    this.clearExpand()
    this.root = treeForGrid(ids, this.shapeFor(count).cols)
    this.rebuild()
    this.onLayoutChange?.()
  }

  /** Apply a restored split tree (validated by `parseTree` — leaf ids are 1..n). */
  applyTree(tree: LayoutTreeNode): void {
    this.clearExpand()
    this.root = normalize(tree)
    this.rebuild()
    this.onLayoutChange?.()
  }

  /** The persisted form of the current layout (ids renumbered to slot order). */
  serialize(): string {
    return serializeTree(this.root)
  }

  /** The global id the NEXT split will create — the controller seeds the new pane's
   *  cwd on the pane-cwd port BEFORE the slot exists (panes read seeds at spawn). */
  peekNextPaneId(): PaneId {
    return (this.baseId + this.nextFreeLocalId()) as PaneId
  }

  private nextFreeLocalId(): number {
    const used = new Set(leafIds(this.root))
    let i = 1
    while (used.has(i)) i++
    return i
  }

  /** Split a pane: a new terminal joins `paneId`'s line along `dir` (auto: the pane's
   *  longer axis) and the LINE RE-EQUALIZES. Returns the new pane's global id. */
  splitPane(paneId: number, dir?: SplitDir): PaneId | null {
    const localTarget = paneId - this.baseId
    if (!leafIds(this.root).includes(localTarget)) return null
    if (this.paneCount >= MAX_PANES) return null
    const newLocal = this.nextFreeLocalId()
    const rect = this.leafRects.get(localTarget)
    const chosen: SplitDir = dir ?? (rect && rect.h > rect.w ? 'v' : 'h')
    this.clearExpand()
    this.root = splitLine(this.root, localTarget, newLocal, chosen)
    this.rebuild()
    const el = this.slotEls.get(newLocal)
    if (el) this.setFocused(el)
    this.onLayoutChange?.()
    return (this.baseId + newLocal) as PaneId
  }

  /** Close one pane: its slot leaves the grid (the slots port disposes its terminal +
   *  PTY) and its line absorbs the space. The caller guards the last-pane case. */
  closePane(paneId: number): void {
    const localId = paneId - this.baseId
    if (!leafIds(this.root).includes(localId) || this.paneCount <= 1) return
    this.clearExpand()
    const next = removeLeaf(this.root, localId)
    if (!next) return
    this.root = next
    this.rebuild()
    this.onLayoutChange?.()
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

  /** Sync DOM to the tree: create/drop slot + gutter elements, position everything,
   *  publish the slot set. Elements are REUSED by key (pane id / seam path), so panes
   *  stay mounted and a hovered gutter keeps its hover through a reflow. */
  private rebuild(): void {
    const ids = leafIds(this.root)
    for (const [id, el] of this.slotEls) {
      if (!ids.includes(id)) {
        el.remove()
        this.slotEls.delete(id)
        const timer = this.pulseTimers.get(id)
        if (timer != null) {
          clearTimeout(timer)
          this.pulseTimers.delete(id)
        }
      }
    }
    const slots: LayoutSlot[] = []
    for (const id of ids) {
      const el = this.ensureSlot(id)
      el.classList.remove('expanded', 'covered')
      if (el.parentElement !== this.grid) this.grid.append(el)
      slots.push({ id: (this.baseId + id) as PaneId, el })
    }

    this.reflow() // computes leaf/gutter/split rects + positions the slots

    const want = new Map(this.gutterSpecs.map((g) => [`${g.path}:${g.index}`, g]))
    for (const [key, el] of this.gutterEls) {
      if (!want.has(key)) {
        el.remove()
        this.gutterEls.delete(key)
      }
    }
    for (const [key, g] of want) {
      let el = this.gutterEls.get(key)
      if (!el) {
        el = this.makeGutter(g)
        this.gutterEls.set(key, el)
        this.grid.append(el)
      }
      setRect(el, g.rect)
    }

    if (!this.grid.querySelector('.layout-slot.focused')) {
      const first = this.slotEls.get(ids[0]!)
      if (first) this.setFocused(first)
    }
    publishSlots(this.source, slots)
  }

  /** Geometry-only pass: recompute rects from the tree and restyle in place (drag
   *  moves, container resizes). No DOM churn, no republish. */
  private reflow(): void {
    const W = this.grid.clientWidth
    const H = this.grid.clientHeight
    const layout = computeLayout(this.root, { x: 0, y: 0, w: W, h: H }, GUTTER)
    this.leafRects = layout.leaves
    this.splitRects = layout.splits
    this.gutterSpecs = layout.gutters

    const target = this.expandedId != null ? layout.leaves.get(this.expandedId) : undefined
    for (const [id, rect] of layout.leaves) {
      const el = this.slotEls.get(id)
      if (!el) continue
      let r = rect
      let covered = false
      if (this.expandedId != null && target) {
        if (id === this.expandedId) r = this.expandedRect(target, W, H)
        else covered = this.coveredByExpand(target, rect)
      }
      el.classList.toggle('covered', covered)
      setRect(el, r)
    }
    for (const g of layout.gutters) {
      const el = this.gutterEls.get(`${g.path}:${g.index}`)
      if (el) setRect(el, g.rect)
    }
  }

  private expandedRect(target: Rect, W: number, H: number): Rect {
    if (this.expandMode === 'col') return { x: target.x, y: 0, w: target.w, h: H }
    if (this.expandMode === 'row') return { x: 0, y: target.y, w: W, h: target.h }
    return { x: 0, y: 0, w: W, h: H }
  }

  /** Does the expanded pane's new footprint hide this sibling? Overlap by RECT, not
   *  by grid lane — exact for every tree shape, uniform or ragged. */
  private coveredByExpand(target: Rect, r: Rect): boolean {
    if (this.expandMode === 'full') return true
    if (this.expandMode === 'col') return r.x < target.x + target.w && r.x + r.w > target.x
    return r.y < target.y + target.h && r.y + r.h > target.y
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
      this.reflow()
      this.setFocused(slot)
      getTelemetry().captureEvent({ name: 'pane.expanded', props: { mode, on: false } })
      return
    }
    getTelemetry().captureEvent({ name: 'pane.expanded', props: { mode, on: true } })

    this.expandedId = localId
    this.expandMode = mode
    slot.classList.add('expanded')
    // The header's matching expand button lights up off this stamp (global.css pairs
    // it with the button's data-expand) — the pressed-state cue for the expand trio.
    slot.dataset.expandMode = mode
    this.grid.classList.add('has-expand')
    this.reflow()
    this.setFocused(slot)
  }

  private clearExpand(): void {
    if (this.expandedId != null) {
      const prev = this.slotEls.get(this.expandedId)
      if (prev) {
        prev.classList.remove('expanded')
        delete prev.dataset.expandMode // the header button's pressed cue goes with it
      }
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

  /** One-shot status flash on a pane's slot — the "look HERE" cue the workspace
   *  controller fires on activation (and on a flip while the workspace is already in
   *  front of you). `kind` picks the color: 'input' = blocked on you (vivid red),
   *  'finished' = done working (vivid green). Class off -> reflow -> on replays the
   *  animation from frame 0 even mid-pulse; the timer (not animationend) removes it,
   *  because reduced-motion swaps the animation and its end event with it. */
  pulseAttention(paneId: number, kind: 'input' | 'finished' = 'input'): void {
    const localId = paneId - this.baseId
    const el = this.slotEls.get(localId)
    if (!el) return
    const prev = this.pulseTimers.get(localId)
    if (prev != null) clearTimeout(prev)
    el.classList.remove('attn-pulse', 'pulse-input', 'pulse-finished')
    void el.offsetWidth // commit the removal, so re-adding restarts the one-shot
    el.classList.add('attn-pulse', kind === 'finished' ? 'pulse-finished' : 'pulse-input')
    this.pulseTimers.set(
      localId,
      window.setTimeout(() => {
        el.classList.remove('attn-pulse', 'pulse-input', 'pulse-finished')
        this.pulseTimers.delete(localId)
      }, 3200) // > the 3s pulse AND the 1.8s reduced-motion fade — neither is cut short
    )
  }

  /** Move focus to the neighboring pane in a direction (keyboard pane nav). Spatial:
   *  nearest visible pane whose center lies that way — exact for any tree shape. */
  focusDir(dir: 'left' | 'right' | 'up' | 'down'): void {
    const focused = this.focusedPaneId()
    const local = focused != null ? focused - this.baseId : leafIds(this.root)[0]!
    const from = this.leafRects.get(local)
    if (!from) return
    const cx = from.x + from.w / 2
    const cy = from.y + from.h / 2
    let best: { id: number; score: number } | null = null
    for (const [id, r] of this.leafRects) {
      if (id === local) continue
      if (this.slotEls.get(id)?.classList.contains('covered')) continue
      const ox = r.x + r.w / 2 - cx
      const oy = r.y + r.h / 2 - cy
      const main = dir === 'left' ? -ox : dir === 'right' ? ox : dir === 'up' ? -oy : oy
      const cross = dir === 'left' || dir === 'right' ? Math.abs(oy) : Math.abs(ox)
      if (main <= 1) continue // strictly beyond us in that direction
      const score = main + cross * 2 // prefer aligned neighbors over diagonal ones
      if (!best || score < best.score) best = { id, score }
    }
    const slot = best ? this.slotEls.get(best.id) : undefined
    if (slot) {
      this.setFocused(slot)
      // Deliberate keyboard navigation INTO a pane counts as looking at it — the
      // keyboard twin of the click acknowledgment in the grid mousedown handler.
      if (best) acknowledgeFinished((this.baseId + best.id) as PaneId)
    }
  }

  // ── Seam resize ──────────────────────────────────────────────────────────────

  private makeGutter(spec: GutterSpec): HTMLElement {
    const g = document.createElement('div')
    g.className = `layout-gutter ${spec.dir === 'h' ? 'vertical' : 'horizontal'}`
    g.dataset.path = spec.path
    g.dataset.index = String(spec.index)
    g.addEventListener('mousedown', (e) => this.startGutterDrag(e, g.dataset.path ?? '', Number(g.dataset.index)))
    return g
  }

  /** Drag ONE seam of ONE line: only `sizes[index-1]`/`sizes[index]` of the split at
   *  `path` change, so panes on other lines never move — the whole point of the tree. */
  private startGutterDrag(e: MouseEvent, path: string, index: number): void {
    const split = nodeAtPath(this.root, path)
    const rect = this.splitRects.get(path)
    if (!split || !isSplit(split) || !rect) return
    e.preventDefault()
    const horizontal = split.dir === 'h'
    const innerPx = Math.max(1, (horizontal ? rect.w : rect.h) - GUTTER * (split.children.length - 1))
    const startPos = horizontal ? e.clientX : e.clientY
    const a0 = split.sizes[index - 1]!
    const b0 = split.sizes[index]!
    const pair = a0 + b0
    const minFr = Math.min(MIN_PANE_PX / innerPx, pair / 2)
    const move = (ev: MouseEvent): void => {
      const pos = horizontal ? ev.clientX : ev.clientY
      const delta = (pos - startPos) / innerPx
      const na = Math.min(Math.max(a0 + delta, minFr), pair - minFr)
      split.sizes[index - 1] = na
      split.sizes[index] = pair - na
      this.reflow()
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
      getTelemetry().captureEvent({ name: 'layout.resized', props: { dir: split.dir } })
      this.onLayoutChange?.()
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // ── Drag-to-rearrange ────────────────────────────────────────────────────────

  /** Drag a pane by its header: drop near another pane's edge to place it on that
   *  side, on its center to swap, or in a workspace-edge band for a full column/row.
   *  A <6px move stays a plain click, so focus/rename/dblclick behave as before. */
  private wirePaneDrag(): void {
    this.grid.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      const t = e.target as HTMLElement
      if (t.closest('button, input, a, .menu, .layout-gutter')) return
      if (!t.closest('.pane-header')) return
      const slot = t.closest('.layout-slot') as HTMLElement | null
      if (!slot || slot.parentElement !== this.grid) return
      if (this.expandedId != null || this.paneCount < 2) return
      const srcId = Number(slot.dataset.paneId) - this.baseId
      const startX = e.clientX
      const startY = e.clientY
      let active = false
      const move = (ev: MouseEvent): void => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
          active = true
          document.body.classList.add('pane-dragging')
          slot.classList.add('drag-source')
          this.dropHint = document.createElement('div')
          this.dropHint.className = 'layout-drop-hint'
          this.dropHint.hidden = true
          this.grid.append(this.dropHint)
        }
        ev.preventDefault()
        this.showDropHint(srcId, this.zoneAt(srcId, ev))
      }
      const up = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        if (!active) return
        document.body.classList.remove('pane-dragging')
        slot.classList.remove('drag-source')
        this.dropHint?.remove()
        this.dropHint = null
        const zone = this.zoneAt(srcId, ev)
        if (zone) this.applyDrop(srcId, zone)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }

  /** What would dropping here do? Workspace-edge bands win over pane zones; inside a
   *  pane, the middle is swap and the nearest edge is insert-on-that-side. */
  private zoneAt(srcId: number, ev: MouseEvent): DropZone | null {
    const gr = this.grid.getBoundingClientRect()
    const px = ev.clientX - gr.left
    const py = ev.clientY - gr.top
    if (px < 0 || py < 0 || px > gr.width || py > gr.height) return null
    if (px < ROOT_EDGE_PX) return { kind: 'root', edge: 'left' }
    if (gr.width - px < ROOT_EDGE_PX) return { kind: 'root', edge: 'right' }
    if (py < ROOT_EDGE_PX) return { kind: 'root', edge: 'top' }
    if (gr.height - py < ROOT_EDGE_PX) return { kind: 'root', edge: 'bottom' }
    for (const [id, r] of this.leafRects) {
      if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue
      if (id === srcId) return null // dropping on yourself does nothing
      const rx = (px - r.x) / Math.max(1, r.w)
      const ry = (py - r.y) / Math.max(1, r.h)
      if (rx > 0.28 && rx < 0.72 && ry > 0.28 && ry < 0.72) {
        return { kind: 'pane', targetId: id, edge: 'center' }
      }
      const d = Math.min(rx, 1 - rx, ry, 1 - ry)
      const edge: DropEdge = d === rx ? 'left' : d === 1 - rx ? 'right' : d === ry ? 'top' : 'bottom'
      return { kind: 'pane', targetId: id, edge }
    }
    return null
  }

  /** Preview the drop: half the target pane for an edge, the whole pane for a swap,
   *  a band along the workspace for a root-edge drop. */
  private showDropHint(_srcId: number, zone: DropZone | null): void {
    const hint = this.dropHint
    if (!hint) return
    if (!zone) {
      hint.hidden = true
      return
    }
    hint.hidden = false
    const W = this.grid.clientWidth
    const H = this.grid.clientHeight
    let r: Rect
    let swap = false
    if (zone.kind === 'root') {
      const band = Math.round(Math.min(W, H) * 0.22)
      r =
        zone.edge === 'left'
          ? { x: 0, y: 0, w: band, h: H }
          : zone.edge === 'right'
            ? { x: W - band, y: 0, w: band, h: H }
            : zone.edge === 'top'
              ? { x: 0, y: 0, w: W, h: band }
              : { x: 0, y: H - band, w: W, h: band }
    } else {
      const t = this.leafRects.get(zone.targetId)
      if (!t) {
        hint.hidden = true
        return
      }
      swap = zone.edge === 'center'
      r =
        zone.edge === 'center'
          ? t
          : zone.edge === 'left'
            ? { x: t.x, y: t.y, w: t.w / 2, h: t.h }
            : zone.edge === 'right'
              ? { x: t.x + t.w / 2, y: t.y, w: t.w / 2, h: t.h }
              : zone.edge === 'top'
                ? { x: t.x, y: t.y, w: t.w, h: t.h / 2 }
                : { x: t.x, y: t.y + t.h / 2, w: t.w, h: t.h / 2 }
    }
    hint.classList.toggle('is-swap', swap)
    setRect(hint, r)
  }

  private applyDrop(srcId: number, zone: DropZone): void {
    if (zone.kind === 'pane') {
      if (zone.edge === 'center') swapLeaves(this.root, srcId, zone.targetId)
      else this.root = moveLeaf(this.root, srcId, zone.targetId, zone.edge)
    } else {
      this.root = moveLeafToRootEdge(this.root, srcId, zone.edge)
    }
    this.rebuild()
    const el = this.slotEls.get(srcId)
    if (el) this.setFocused(el)
    getTelemetry().captureEvent({
      name: 'pane.moved',
      props: { drop: zone.kind === 'pane' ? zone.edge : `root-${zone.edge}` }
    })
    this.onLayoutChange?.()
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
    this.resizeObs.disconnect()
    clearSlots(this.source)
    this.grid.remove()
  }
}

function setRect(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`
  el.style.top = `${r.y}px`
  el.style.width = `${r.w}px`
  el.style.height = `${r.h}px`
}
