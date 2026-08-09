# `ui/features/layout` — split-tree pane layout

Replaces the Phase-0 single hardcoded pane with a resizable **split tree of slots**
(Phase-1/04 as a grid; re-founded on a tree for per-seam resize + drag-rearrange).

- `templates.ts` — pane-count → grid dims (1/2/4/6/8/9/12/16, all exact grids). The shape
  source for the wizard's layout picker and the palette/control `layout` verbs; a template
  is applied by building the matching tree. `gridShapeFor` (curated shape, else
  near-square) is the one formula any surface reads when it has to name the shape a count
  lands on.
- `layout-tree.ts` — the pure model: leaves are panes, splits are LINES ('h' side-by-side /
  'v' stacked) with fractional sizes. All mutations live here (split/remove/move/swap/
  serialize), DOM-free and normalize-guarded.
- `grid-layout.ts` — `GridLayout`: renders the tree as absolutely-positioned slots +
  per-seam drag **gutters** + focus tracking. Slot elements are **reused by pane id**
  across every mutation (template change, split, drag), so a pane's PTY is never killed
  by rearranging — never, because `slot-selection.ts` puts EVERY live slot in the new
  layout before it grows into a free one. Only a genuine shrink closes anything.
- `slot-selection.ts` — the pure rule for **which slots a new layout lands on**: all live
  slots first (a live slot is a running terminal; a free one is nothing — never trade),
  ordered by where each pane already sits on screen, then the lowest ids free across every
  workspace. Reading order, not slot number: `splitLine` inserts a new leaf beside its
  target, so slot numbering stopped meaning position at the first split.
- `index.ts` — exports the components (`workspace` composes one `GridLayout` per
  workspace; `layout` registers no UiFeature of its own).

## Behaviors (user contracts)
- **Resize**: every gutter is ONE seam of ONE line — dragging it resizes only the panes
  touching that seam, never a whole row/column of the workspace. Works for any tree,
  including former "ragged" counts (3/5/7…), which previously couldn't resize at all.
- **Add terminals** (pane ⋯ menu split, Ctrl+Shift+D, palette): the new pane joins the
  focused pane's line (auto direction: the pane's longer axis) and the line
  **re-equalizes** — every terminal in it gets an equal share. The new shell opens in the
  split pane's cwd. The layout popover's **"New terminal…"** row instead opens a modal
  where you PAINT where the terminals go, what runs in each, and whether each gets its own
  git worktree; Ctrl+Shift+D stays a plain single split by design.
- **Reorganize** (layout popover / palette): opens the layout **painter** on the live
  workspace — pick a new grid size on the lattice, drag across cells to merge them into
  spanning terminals, and change the pane count while you are there. Terminals you already
  have are kept and land in the region nearest where they already sit (reading order,
  top-left → bottom-right), so a reshape reads as a resize. Growing opens fresh slots after
  them; shrinking closes from the bottom-right and asks first when a closing pane holds
  live work. The structural sibling of Balance (which equalizes sizes but never structure).
- **Equalize**: double-click a gutter (or press `=` on a focused one) and its whole LINE
  takes equal shares — per member, so a nested stack counts as one column. The pane ⋯
  menu offers the same per axis ("Equal widths in this row" / "Equal heights in this
  column"), shown only when such a line contains the pane: a pane that SPANS the other
  axis is a sibling in an outer line and gets no entry (slots carry `data-eq-axes`).
  "Balance layout" (layout popover / palette / Ctrl+Shift+=) equalizes every line.
  Sizes-only in all cases; the floors below still clamp rendering, equal WEIGHTS persist.
- **Drag-rearrange**: drag a pane by its header. Drop near another pane's edge to take
  half of it (structure follows), on its center to swap, in a workspace-edge band for a
  full-height column / full-width row there.
- **Expand modes** per pane (full workspace / full height / full width) and per-pane CLOSE
  (its line absorbs the space) as before.
- **Persistence**: the serialized tree (shape + sizes, leaf ids **preserved verbatim** —
  renumbering them to slot order silently broke every restore of a workspace that had
  closed a middle pane) rides `WorkspaceStateMeta.layout`; restore re-applies it exactly,
  falling back to the template grid on any doubt. A closed middle slot therefore leaves a
  real gap in the numbering that outlives a restart, which is why `slot-selection.ts` must
  never fill one ahead of a live pane.

## Decoupling (guardrail)
`layout` **does not import `terminal`**. It publishes its slots via `@ui/core/layout/slots`
(`publishSlots` / `onSlots`, keyed by `PaneId` from `@contracts`); the `terminal` feature
subscribes and mounts a `TerminalPane` into each slot. Split requests flow the other way
as bubbling DOM events (`mogging:split-pane`), handled by the `workspace` controller —
it must seed the new pane's cwd before the slot exists. The features meet only at that
port + `@contracts`. See `docs/04-adding-a-feature.md`.

## Perf
WebGL renderer per pane. Chromium caps ~16 live WebGL contexts, but that is **not** a pane
limit and nothing enforces it as one: panes past that edge ride the DOM renderer through
`PaneWebglManager`'s managed fallback (`grid-layout.ts` `limit()`). The real ceiling is the
capacity model — screen ∧ machine ∧ plan, `ABS_MAX_PANES = 32` at the top (`pane-capacity.ts`).
Scrollback is capped per pane; the cursor blinks only in the focused pane to cut idle
repaints. Geometry is one JS pass per mutation/resize (rects set as inline px; a
`ResizeObserver` on the grid re-derives them, including the 0→W flip when a hidden
workspace is revealed).
