/**
 * The split-tree layout model (pure data, no DOM — `grid-layout.ts` renders it).
 *
 * A layout is a tree: leaves are panes, splits are LINES of children laid out either
 * side-by-side (`'h'`) or stacked (`'v'`), each child holding a fraction of the line
 * (`sizes`, normalized to sum 1). This is the same model Warp/tmux/VS Code use, and it
 * is what makes every user-facing behavior fall out naturally:
 *   - a divider belongs to exactly ONE seam of ONE line, so dragging it resizes only
 *     the two subtrees touching that seam — never a whole grid track;
 *   - adding a terminal splits into a line and the line RE-EQUALIZES (user contract:
 *     "when we add a new terminal, all terminals in that line are equally sized");
 *   - drag-to-rearrange is remove + re-insert (edge drop) or an id swap (center drop).
 *
 * Invariants (restored by `normalize` after every mutation):
 *   - a split has ≥2 children and sizes.length === children.length, sizes sum to 1;
 *   - no split contains a child split of the SAME direction (merged, sizes scaled);
 *   - leaf ids are unique.
 */

export type SplitDir = 'h' | 'v' // 'h': children side by side · 'v': children stacked

export interface LeafNode {
  id: number
}
export interface SplitNode {
  dir: SplitDir
  sizes: number[]
  children: LayoutTreeNode[]
}
export type LayoutTreeNode = LeafNode | SplitNode

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One draggable seam of one split: between children `index-1` and `index` of the
 *  split at `path`. `dir` is the SPLIT's direction ('h' split -> vertical seam). */
export interface GutterSpec {
  path: string
  index: number
  dir: SplitDir
  rect: Rect
}

export interface ComputedLayout {
  leaves: Map<number, Rect>
  gutters: GutterSpec[]
  /** Each split node's own rect, by path — the resize drag converts px to fractions
   *  against the split's inner size, so a seam deep in the tree feels 1:1. */
  splits: Map<string, Rect>
}

export function isSplit(n: LayoutTreeNode): n is SplitNode {
  return (n as SplitNode).children !== undefined
}

/** Leaf ids in DFS order — reading order (row-major for template grids). */
export function leafIds(n: LayoutTreeNode): number[] {
  if (!isSplit(n)) return [n.id]
  return n.children.flatMap(leafIds)
}

export function leafCount(n: LayoutTreeNode): number {
  return isSplit(n) ? n.children.reduce((s, c) => s + leafCount(c), 0) : 1
}

/** The node at a dot path ('' = root, '0.1' = root.children[0].children[1]). */
export function nodeAtPath(root: LayoutTreeNode, path: string): LayoutTreeNode | null {
  if (path === '') return root
  let n: LayoutTreeNode = root
  for (const part of path.split('.')) {
    if (!isSplit(n)) return null
    const next: LayoutTreeNode | undefined = n.children[Number(part)]
    if (!next) return null
    n = next
  }
  return n
}

/** Restore the invariants: merge same-dir nesting, collapse 1-child splits, repair
 *  degenerate size arrays, renormalize sums. Returns a possibly-new node. */
export function normalize(n: LayoutTreeNode): LayoutTreeNode {
  if (!isSplit(n)) return n
  const kids: LayoutTreeNode[] = []
  const sizes: number[] = []
  n.children.forEach((c, i) => {
    const nc = normalize(c)
    const sz = Number.isFinite(n.sizes[i]) && n.sizes[i]! > 0 ? n.sizes[i]! : 0
    if (isSplit(nc) && nc.dir === n.dir) {
      // A same-dir child is the SAME line — inline its children, scaled by its share.
      nc.children.forEach((gc, j) => {
        kids.push(gc)
        sizes.push(sz * nc.sizes[j]!)
      })
    } else {
      kids.push(nc)
      sizes.push(sz)
    }
  })
  if (kids.length === 0) return { id: 1 } // unreachable by construction; a safe floor
  if (kids.length === 1) return kids[0]!
  const total = sizes.reduce((s, v) => s + v, 0)
  const fixed = total > 0 ? sizes.map((s) => s / total) : kids.map(() => 1 / kids.length)
  return { dir: n.dir, children: kids, sizes: fixed }
}

interface LeafLocation {
  parent: SplitNode | null // null: the root itself is the leaf
  index: number
}

function findLeaf(n: LayoutTreeNode, id: number, parent: SplitNode | null = null, index = 0): LeafLocation | null {
  if (!isSplit(n)) return n.id === id ? { parent, index } : null
  for (let i = 0; i < n.children.length; i++) {
    const r = findLeaf(n.children[i]!, id, n, i)
    if (r) return r
  }
  return null
}

function findLeafNode(n: LayoutTreeNode, id: number): LeafNode | null {
  if (!isSplit(n)) return n.id === id ? n : null
  for (const c of n.children) {
    const r = findLeafNode(c, id)
    if (r) return r
  }
  return null
}

/** Replace the leaf `id` with `replacement` (used to open a new line inside a pane). */
function replaceLeaf(root: LayoutTreeNode, id: number, replacement: LayoutTreeNode): LayoutTreeNode {
  const loc = findLeaf(root, id)
  if (!loc) return root
  if (!loc.parent) return replacement
  loc.parent.children[loc.index] = replacement
  return root
}

/** A template grid as a tree: `ids` chunked into rows of `cols` (ragged last row OK),
 *  every row and every column share equal. Shapes match the curated TEMPLATES. */
export function treeForGrid(ids: number[], cols: number): LayoutTreeNode {
  if (ids.length === 1) return { id: ids[0]! }
  const rows: LayoutTreeNode[] = []
  for (let i = 0; i < ids.length; i += cols) {
    const rowIds = ids.slice(i, i + cols)
    rows.push(
      rowIds.length === 1
        ? { id: rowIds[0]! }
        : { dir: 'h', children: rowIds.map((id) => ({ id })), sizes: rowIds.map(() => 1 / rowIds.length) }
    )
  }
  if (rows.length === 1) return rows[0]!
  return normalize({ dir: 'v', children: rows, sizes: rows.map(() => 1 / rows.length) })
}

/**
 * ADD a terminal next to `targetId` along `dir`. If the target already sits in a line
 * of that direction, the new pane joins the line and the WHOLE LINE re-equalizes
 * (the user contract for "+"). Otherwise the target pane itself splits into a new
 * 2-pane line (equal halves — a line of two, equally sized).
 */
export function splitLine(root: LayoutTreeNode, targetId: number, newId: number, dir: SplitDir): LayoutTreeNode {
  const loc = findLeaf(root, targetId)
  if (!loc) return root
  const leaf: LeafNode = { id: newId }
  if (loc.parent && loc.parent.dir === dir) {
    loc.parent.children.splice(loc.index + 1, 0, leaf)
    const k = loc.parent.children.length
    loc.parent.sizes = loc.parent.children.map(() => 1 / k)
    return normalize(root)
  }
  const split: SplitNode = { dir, children: [{ id: targetId }, leaf], sizes: [0.5, 0.5] }
  return normalize(replaceLeaf(root, targetId, split))
}

/** INSERT `movedId` beside `targetId` (drag-drop): the target's cell splits in half —
 *  custom sizes elsewhere in the line are preserved (Warp semantics; deliberately
 *  different from `splitLine`, which is the equalizing ADD). */
export function insertBeside(
  root: LayoutTreeNode,
  targetId: number,
  movedId: number,
  dir: SplitDir,
  before: boolean
): LayoutTreeNode {
  const moved: LeafNode = { id: movedId }
  const target: LeafNode = { id: targetId }
  const split: SplitNode = {
    dir,
    children: before ? [moved, target] : [target, moved],
    sizes: [0.5, 0.5]
  }
  return normalize(replaceLeaf(root, targetId, split))
}

/** Remove a leaf; its line absorbs the space proportionally. Null if it was the last pane. */
export function removeLeaf(root: LayoutTreeNode, id: number): LayoutTreeNode | null {
  const loc = findLeaf(root, id)
  if (!loc) return root
  if (!loc.parent) return null
  loc.parent.children.splice(loc.index, 1)
  loc.parent.sizes.splice(loc.index, 1)
  return normalize(root)
}

/** Swap two panes in place (center drop) — ids trade positions, geometry untouched. */
export function swapLeaves(root: LayoutTreeNode, a: number, b: number): void {
  const la = findLeafNode(root, a)
  const lb = findLeafNode(root, b)
  if (!la || !lb || la === lb) return
  la.id = b
  lb.id = a
}

export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

/** Move a pane next to another pane's edge (drag-drop restructure). */
export function moveLeaf(root: LayoutTreeNode, srcId: number, targetId: number, edge: DropEdge): LayoutTreeNode {
  if (srcId === targetId) return root
  const without = removeLeaf(root, srcId)
  if (!without) return root
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'h' : 'v'
  return insertBeside(without, targetId, srcId, dir, edge === 'left' || edge === 'top')
}

/** Move a pane to a WORKSPACE edge: a full-height column / full-width row there,
 *  sized to one more even share of the layout (clamped sane). */
export function moveLeafToRootEdge(root: LayoutTreeNode, srcId: number, edge: DropEdge): LayoutTreeNode {
  const without = removeLeaf(root, srcId)
  if (!without) return root
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'h' : 'v'
  const before = edge === 'left' || edge === 'top'
  const leaf: LeafNode = { id: srcId }
  const share = Math.min(0.5, Math.max(0.15, 1 / (leafCount(without) + 1)))
  if (isSplit(without) && without.dir === dir) {
    without.sizes = without.sizes.map((s) => s * (1 - share))
    without.children.splice(before ? 0 : without.children.length, 0, leaf)
    without.sizes.splice(before ? 0 : without.sizes.length, 0, share)
    return normalize(without)
  }
  return normalize({
    dir,
    children: before ? [leaf, without] : [without, leaf],
    sizes: before ? [share, 1 - share] : [1 - share, share]
  })
}

/** Compute every leaf/gutter/split rect for a container rect. Pixel-exact: children
 *  are placed at rounded cumulative boundaries so nothing drifts, and the LAST child
 *  absorbs the remainder. */
export function computeLayout(root: LayoutTreeNode, rect: Rect, gutterPx: number): ComputedLayout {
  const out: ComputedLayout = { leaves: new Map(), gutters: [], splits: new Map() }
  const walk = (n: LayoutTreeNode, r: Rect, path: string): void => {
    if (!isSplit(n)) {
      out.leaves.set(n.id, r)
      return
    }
    out.splits.set(path, r)
    const k = n.children.length
    const total = n.dir === 'h' ? r.w : r.h
    const inner = Math.max(0, total - gutterPx * (k - 1))
    let acc = 0
    let prevCut = 0
    let offset = 0
    for (let i = 0; i < k; i++) {
      acc += n.sizes[i]!
      const cut = i === k - 1 ? inner : Math.round(inner * acc)
      const span = Math.max(0, cut - prevCut)
      prevCut = cut
      const childRect: Rect =
        n.dir === 'h'
          ? { x: r.x + offset, y: r.y, w: span, h: r.h }
          : { x: r.x, y: r.y + offset, w: r.w, h: span }
      walk(n.children[i]!, childRect, path === '' ? String(i) : `${path}.${i}`)
      offset += span
      if (i < k - 1) {
        out.gutters.push({
          path,
          index: i + 1,
          dir: n.dir,
          rect:
            n.dir === 'h'
              ? { x: r.x + offset, y: r.y, w: gutterPx, h: r.h }
              : { x: r.x, y: r.y + offset, w: r.w, h: gutterPx }
        })
        offset += gutterPx
      }
    }
  }
  walk(root, rect, '')
  return out
}

// ── Persistence (geometry only — shape + sizes; never content, ADR 0002) ──────────

interface SerializedV1 {
  v: 1
  root: unknown
}

/** Serialize with leaf ids RENUMBERED 1..n in reading order — restore seeds pane
 *  cwds/roles by slot index, so persisted ids must be the contiguous slot ids. */
export function serializeTree(root: LayoutTreeNode): string {
  let next = 1
  const clone = (n: LayoutTreeNode): unknown =>
    isSplit(n)
      ? {
          dir: n.dir,
          sizes: n.sizes.map((s) => Math.round(s * 10000) / 10000),
          children: n.children.map(clone)
        }
      : { id: next++ }
  const payload: SerializedV1 = { v: 1, root: clone(root) }
  return JSON.stringify(payload)
}

const MAX_LEAVES = 32
const MAX_DEPTH = 10

/** Parse + validate a persisted layout. Returns null on ANY doubt — the caller falls
 *  back to the template grid for `expectedCount`, so a bad row can never wedge boot. */
export function parseTree(json: string, expectedCount: number): LayoutTreeNode | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const payload = raw as Partial<SerializedV1>
  if (!payload || payload.v !== 1 || payload.root == null) return null
  const ids: number[] = []
  const check = (n: unknown, depth: number): LayoutTreeNode | null => {
    if (depth > MAX_DEPTH || ids.length > MAX_LEAVES || typeof n !== 'object' || n === null) return null
    const leaf = n as Partial<LeafNode>
    if (typeof leaf.id === 'number') {
      if (!Number.isInteger(leaf.id) || leaf.id < 1) return null
      ids.push(leaf.id)
      return { id: leaf.id }
    }
    const split = n as Partial<SplitNode>
    if (
      (split.dir !== 'h' && split.dir !== 'v') ||
      !Array.isArray(split.children) ||
      !Array.isArray(split.sizes) ||
      split.children.length < 2 ||
      split.sizes.length !== split.children.length ||
      !split.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)
    ) {
      return null
    }
    const children: LayoutTreeNode[] = []
    for (const c of split.children) {
      const cc = check(c, depth + 1)
      if (!cc) return null
      children.push(cc)
    }
    return { dir: split.dir, children, sizes: [...split.sizes] }
  }
  const root = check(payload.root, 0)
  if (!root) return null
  if (ids.length !== expectedCount) return null
  const want = new Set(Array.from({ length: expectedCount }, (_, i) => i + 1))
  for (const id of ids) {
    if (!want.delete(id)) return null // duplicate or out-of-range id
  }
  return normalize(root)
}
