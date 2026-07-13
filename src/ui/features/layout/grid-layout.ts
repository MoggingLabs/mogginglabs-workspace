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
  MIN_PANE_WIDTH_PX,
  minimumLayoutWidth,
  moveLeaf,
  moveLeafToRootEdge,
  nodeAtPath,
  normalize,
  removeLeaf,
  resizeSplitWeights,
  serializeTree,
  splitLine,
  swapLeaves,
  treeForGrid,
  type DropEdge,
  type GutterSpec,
  type LayoutTreeNode,
  type Rect,
  type SplitDir,
  type SplitNode
} from './layout-tree'

export { parseTree, leafIds, MIN_PANE_WIDTH_PX, minimumLayoutWidth } from './layout-tree'
export type { LayoutTreeNode, SplitDir } from './layout-tree'

const GUTTER = 2 // px between panes — with each pane's 1px border: a 4px seam, matching the app edge
const MIN_PANE_HEIGHT_PX = 110 // retain the existing direct vertical-gutter drag floor
const DRAG_THRESHOLD = 6 // px of header movement before a click becomes a pane drag
const ROOT_EDGE_PX = 14 // workspace-edge drop band ("make this a full column/row here")
/** Keyboard seam travel per arrow press — the cadence the dock separators already ship
 *  (browser/explorer dock handles): a fine step you can aim with, and a coarse one under
 *  Shift for crossing a wide pane without holding the key down. */
const SEAM_STEP_PX = 16
const SEAM_STEP_COARSE_PX = 64
/** A key BURST is one gesture. A mouse drag persists (and reports) exactly once, at mouseup;
 *  an arrow key held down would otherwise serialize + write the workspace manifest on every
 *  repeat. Long enough to swallow a key-repeat train, short enough that a single press lands
 *  in the manifest before anything can close the window on it. */
const SEAM_PERSIST_MS = 200

/** One seam's world, in PIXELS: the two subtrees it separates, their floors, and how far it
 *  can actually travel. The drag, the arrow keys and the ARIA a screen reader announces all
 *  read THIS one derivation — so the number the keyboard hears is by construction the number
 *  the mouse can reach, and an attribute cannot drift from the pixels. */
interface SeamGeometry {
  split: SplitNode
  /** The SPLIT is horizontal (children side by side) — so the seam itself is a vertical line. */
  horizontal: boolean
  /** The split's span minus its gutters: the px the children's fractions divide up. */
  innerPx: number
  /** Every child's px floor (horizontal seams only — `resizeSplitWeights` water-fills against them). */
  childMinimums: number[]
  /** The rendered span of the child BEFORE the seam — the value the seam's ARIA advertises. */
  aPx: number
  /** ...and the two adjacent children together: the seam moves inside this, nothing else moves. */
  pairPx: number
  aMin: number
  bMin: number
}

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
  private readonly scrollHost: HTMLElement
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
  private seamPersistTimer?: ReturnType<typeof setTimeout>
  private readonly followExpandedViewport = (): void => {
    if (this.expandedId != null && this.expandMode !== 'col') this.reflow()
  }

  /** Fired after any user-visible layout mutation (apply/split/close/resize/move) —
   *  the workspace controller persists the serialized tree through it. Assigned
   *  AFTER construction, so the constructor's initial apply stays silent. */
  onLayoutChange?: () => void

  constructor(
    host: HTMLElement,
    private readonly source: string,
    private readonly baseId = 0,
    private readonly onFocus?: (paneId: PaneId) => void,
    /** The tree this grid OPENS with (a restored workspace's exact arrangement, gaps
     *  included). It has to arrive HERE, not in an applyTree after construction: the
     *  initial apply PUBLISHES its slots synchronously, and the terminal feature builds
     *  a pane — and spawns its PTY — for every slot it is handed. In front of a restored
     *  tree with no id 1 (the user closed pane 1 and kept 2,3 — parseTree preserves that
     *  gap), the default 1-pane grid therefore spawned a pane the tree does not have and
     *  disposed it a moment later, sending `kill` while the `spawn` was still in flight:
     *  the kill found no session yet, the spawn then completed, and the daemon — which
     *  outlives the app by design (ADR 0006) — was left holding an ORPHAN shell no
     *  renderer object owns. Omitted = the 1-pane default (a fresh workspace). */
    initial?: LayoutTreeNode
  ) {
    this.scrollHost = host
    this.scrollHost.classList.add('layout-scroll-host')
    this.scrollHost.addEventListener('scroll', this.followExpandedViewport, { passive: true })
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
    // Under horizontal overflow the grid is pinned at its recursive minimum and may
    // not resize when the rail, a dock or the window changes. The viewport still does,
    // and full/row expansion is sized to that viewport, so observe both boxes.
    this.resizeObs.observe(this.scrollHost)
    if (initial) this.applyTree(initial)
    else this.apply(1)
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
      // A gutter created in THIS pass missed the reflow above (it did not exist yet), so its
      // axis and ARIA are seeded here — a seam must never be announced from a stale spec.
      this.syncGutter(el, g)
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
    // The grid is the inner canvas. Its flex host may become narrower (window resize,
    // rail expansion or either right dock), but the canvas keeps the recursive tree
    // requirement and the host scrolls horizontally instead of crushing leaf headers.
    const requiredWidth = minimumLayoutWidth(this.root, GUTTER, MIN_PANE_WIDTH_PX)
    this.grid.style.minWidth = `${requiredWidth}px`
    const W = Math.max(this.grid.clientWidth, requiredWidth)
    const H = this.grid.clientHeight
    const layout = computeLayout(this.root, { x: 0, y: 0, w: W, h: H }, GUTTER, MIN_PANE_WIDTH_PX)
    this.leafRects = layout.leaves
    this.splitRects = layout.splits
    this.gutterSpecs = layout.gutters

    const target = this.expandedId != null ? layout.leaves.get(this.expandedId) : undefined
    const viewportWidth = Math.min(W, Math.max(MIN_PANE_WIDTH_PX, this.scrollHost.clientWidth))
    const viewportX = Math.min(Math.max(0, this.scrollHost.scrollLeft), Math.max(0, W - viewportWidth))
    for (const [id, rect] of layout.leaves) {
      const el = this.slotEls.get(id)
      if (!el) continue
      let r = rect
      let covered = false
      if (this.expandedId != null && target) {
        if (id === this.expandedId) r = this.expandedRect(target, viewportX, viewportWidth, H)
        else covered = this.coveredByExpand(target, rect)
      }
      el.classList.toggle('covered', covered)
      setRect(el, r)
    }
    for (const g of layout.gutters) {
      const el = this.gutterEls.get(`${g.path}:${g.index}`)
      if (!el) continue
      setRect(el, g.rect)
      // The seam's ARIA rides the same pass its RECT does. Anything that moves a seam moves
      // both, so the announced position cannot drift from the pixels — including the moves no
      // one asked for (window resize, rail collapse, a sibling closing).
      this.syncGutter(el, g)
    }
  }

  private expandedRect(target: Rect, viewportX: number, viewportWidth: number, H: number): Rect {
    if (this.expandMode === 'col') return { x: target.x, y: 0, w: target.w, h: H }
    if (this.expandMode === 'row') return { x: viewportX, y: target.y, w: viewportWidth, h: target.h }
    return { x: viewportX, y: 0, w: viewportWidth, h: H }
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
    g.className = 'layout-gutter' // the axis class + every ARIA value: syncGutter, off the live tree
    g.dataset.path = spec.path
    g.dataset.index = String(spec.index)
    // A FOCUSABLE separator (APG), on the same contract the two dock handles already ship —
    // and this is the higher-traffic one: it exists the moment a workspace has two panes.
    // It was a bare <div> with a single mousedown listener, so a keyboard-only user could not
    // rebalance a workspace AT ALL, and a screen reader saw nothing but a decorative box.
    // role + orientation + the live aria-value* (syncGutter) + a tab stop + keys (onGutterKey)
    // are the whole of what makes a separator operable; nothing here invents a new resize.
    g.setAttribute('role', 'separator')
    g.tabIndex = 0
    g.addEventListener('mousedown', (e) => this.startGutterDrag(e, g.dataset.path ?? '', Number(g.dataset.index)))
    g.addEventListener('keydown', (e) => this.onGutterKey(e, g.dataset.path ?? '', Number(g.dataset.index)))
    return g
  }

  /** The RENDERED rect of one child of the split at `path` — a leaf's own, or a child split's.
   *  Both fall out of the SAME reflow pass, so anything derived from them is the pixels on the
   *  screen, not a stored fraction the water-fill may have clamped away (a 10% child pinned at
   *  132px renders 132px, and that is the number the seam must honour and announce). */
  private childRect(path: string, i: number): Rect | undefined {
    const childPath = path === '' ? String(i) : `${path}.${i}`
    const child = nodeAtPath(this.root, childPath)
    if (!child) return undefined
    return isSplit(child) ? this.splitRects.get(childPath) : this.leafRects.get(child.id)
  }

  /** Everything a seam move needs, derived once from the live tree + the rendered rects. */
  private seamGeometry(path: string, index: number): SeamGeometry | null {
    const split = nodeAtPath(this.root, path)
    const rect = this.splitRects.get(path)
    if (!split || !isSplit(split) || !rect) return null
    if (!Number.isInteger(index) || index <= 0 || index >= split.children.length) return null
    const a = this.childRect(path, index - 1)
    const b = this.childRect(path, index)
    if (!a || !b) return null
    const horizontal = split.dir === 'h'
    const innerPx = Math.max(1, (horizontal ? rect.w : rect.h) - GUTTER * (split.children.length - 1))
    const aPx = horizontal ? a.w : a.h
    const pairPx = aPx + (horizontal ? b.w : b.h)
    // The floors are the ones the resize ALREADY enforces, restated in px — not new ones. A
    // horizontal seam owes each subtree its recursive width requirement (what resizeSplitWeights
    // clamps to); a vertical seam owes MIN_PANE_HEIGHT_PX, halving the pair when even that will
    // not fit — the same `Math.min(…, pair / 2)` the drag's minFr does, read in px not fractions.
    const childMinimums = horizontal
      ? split.children.map((child) => minimumLayoutWidth(child, GUTTER, MIN_PANE_WIDTH_PX))
      : []
    const floor = Math.min(MIN_PANE_HEIGHT_PX, pairPx / 2)
    return {
      split,
      horizontal,
      innerPx,
      childMinimums,
      aPx,
      pairPx,
      aMin: horizontal ? childMinimums[index - 1]! : floor,
      bMin: horizontal ? childMinimums[index]! : floor
    }
  }

  /** THE seam move — whichever gesture asked for it. Only `sizes[index-1]`/`sizes[index]` of
   *  the split change, so panes on other lines never move: the whole point of the tree.
   *
   *  `base` is the sizes array the GESTURE started from and `deltaPx` its total travel since,
   *  so a drag applies one absolute delta from mousedown (accumulating per-frame deltas would
   *  drift by a pixel a frame), and a key press is simply a one-shot gesture of ±step from now.
   *  Horizontal seams go through resizeSplitWeights, which moves the pair inside the water-fill
   *  geometry and leaves every non-adjacent child's LATENT preference intact; vertical seams
   *  have no width minimum in the allocator, so they clamp their two fractions directly. */
  private moveSeam(geom: SeamGeometry, index: number, base: number[], deltaPx: number): void {
    const { split, horizontal, innerPx } = geom
    if (horizontal) {
      split.sizes = resizeSplitWeights(innerPx, base, geom.childMinimums, index, deltaPx)
    } else {
      const a0 = base[index - 1]!
      const pair = a0 + base[index]!
      if (!(pair > 0)) return
      const minFr = Math.min(MIN_PANE_HEIGHT_PX / innerPx, pair / 2)
      const na = Math.min(Math.max(a0 + deltaPx / innerPx, minFr), pair - minFr)
      split.sizes = base.slice()
      split.sizes[index - 1] = na
      split.sizes[index] = pair - na
    }
    this.reflow()
  }

  /** Drag ONE seam of ONE line. */
  private startGutterDrag(e: MouseEvent, path: string, index: number): void {
    const geom = this.seamGeometry(path, index)
    if (!geom) return
    const base = geom.split.sizes.slice()
    if (!(base[index - 1]! + base[index]! > 0)) return
    e.preventDefault()
    const startPos = geom.horizontal ? e.clientX : e.clientY
    const move = (ev: MouseEvent): void => {
      this.moveSeam(geom, index, base, (geom.horizontal ? ev.clientX : ev.clientY) - startPos)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
      getTelemetry().captureEvent({ name: 'layout.resized', props: { dir: geom.split.dir } })
      this.onLayoutChange?.()
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** Arrow keys / Home / End on a focused seam — the SAME resize the mouse performs, down to
   *  the same clamps, because it runs the same moveSeam. The seam FOLLOWS the arrow (right/down
   *  grows the pane before it), so aria-valuenow rises as the seam travels toward its max, and
   *  Home/End park it on the two floors: the pane before it at its minimum, or the one after it.
   *  An arrow ACROSS the seam is not this separator's business — it is left to bubble. */
  private onGutterKey(e: KeyboardEvent, path: string, index: number): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const geom = this.seamGeometry(path, index)
    if (!geom) return
    const step = e.shiftKey ? SEAM_STEP_COARSE_PX : SEAM_STEP_PX
    const forward = geom.horizontal ? 'ArrowRight' : 'ArrowDown'
    const backward = geom.horizontal ? 'ArrowLeft' : 'ArrowUp'
    let delta: number
    if (e.key === forward) delta = step
    else if (e.key === backward) delta = -step
    else if (e.key === 'Home') delta = geom.aMin - geom.aPx
    else if (e.key === 'End') delta = geom.pairPx - geom.bMin - geom.aPx
    else return
    e.preventDefault() // Home/End would otherwise scroll the layout host under the seam
    this.moveSeam(geom, index, geom.split.sizes.slice(), delta)
    // One gesture, one persist (SEAM_PERSIST_MS) — a held arrow key is not fifty resizes.
    if (this.seamPersistTimer) clearTimeout(this.seamPersistTimer)
    this.seamPersistTimer = setTimeout(() => {
      this.seamPersistTimer = undefined
      getTelemetry().captureEvent({ name: 'layout.resized', props: { dir: geom.split.dir } })
      this.onLayoutChange?.()
    }, SEAM_PERSIST_MS)
  }

  /** Publish a seam's live axis + position. Re-derived on EVERY reflow, because plenty moves a
   *  seam that nobody touched (a window resize, a sibling closing, a rail collapse) — an
   *  aria-valuenow that only updated when the seam was dragged would be a lie the moment the
   *  window changed size. Two more reasons it is derived, never remembered:
   *
   *   - gutter elements are REUSED by seam key (`path:index`), and a drag-rearrange can flip the
   *     split at that key from 'h' to 'v' — a reused element would otherwise keep the old cursor
   *     class AND announce the old axis;
   *   - a seam whose two neighbours are BOTH already at their floor (a grid pinned at its
   *     recursive minimum) has nowhere to go, and resizeSplitWeights rightly refuses to move it.
   *     It therefore advertises a ZERO-width range AT its own position rather than a range it
   *     cannot reach: aria-valuenow outside [min,max] is a lie no assistive tech can recover from. */
  private syncGutter(el: HTMLElement, spec: GutterSpec): void {
    const vertical = spec.dir === 'h' // children side by side ⇒ the seam between them is a vertical line
    el.classList.toggle('vertical', vertical)
    el.classList.toggle('horizontal', !vertical)
    el.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal')
    el.setAttribute('aria-label', vertical ? 'Resize panes left and right' : 'Resize panes up and down')
    const geom = this.seamGeometry(spec.path, spec.index)
    if (!geom) return
    const at = Math.round(geom.aPx)
    let lo = Math.round(geom.aMin)
    let hi = Math.round(geom.pairPx - geom.bMin)
    if (hi < lo) lo = hi = at // pinned: the pair cannot even hold its own floors
    const min = String(lo)
    const max = String(hi)
    const now = String(Math.max(lo, Math.min(hi, at)))
    // Skip the writes when nothing moved: a reflow storm (a window drag) and a streaming grid at
    // rest both re-derive the same three numbers, and every setAttribute dirties the a11y tree.
    if (
      el.getAttribute('aria-valuenow') === now &&
      el.getAttribute('aria-valuemin') === min &&
      el.getAttribute('aria-valuemax') === max
    ) {
      return
    }
    el.setAttribute('aria-valuemin', min)
    el.setAttribute('aria-valuemax', max)
    el.setAttribute('aria-valuenow', now)
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
    if (this.seamPersistTimer) clearTimeout(this.seamPersistTimer) // a workspace closed mid-nudge must not persist into it
    this.scrollHost.removeEventListener('scroll', this.followExpandedViewport)
    clearSlots(this.source)
    this.grid.remove()
    this.scrollHost.classList.remove('layout-scroll-host')
  }
}

function setRect(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`
  el.style.top = `${r.y}px`
  el.style.width = `${r.w}px`
  el.style.height = `${r.h}px`
}
