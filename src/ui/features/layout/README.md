# `ui/features/layout` — split-tree pane layout

Replaces the Phase-0 single hardcoded pane with a resizable **split tree of slots**
(Phase-1/04 as a grid; re-founded on a tree for per-seam resize + drag-rearrange).

- `templates.ts` — pane-count → grid dims (1/2/4/6/8/9/12/16, all exact grids). Still the
  shape source for the layout picker; a template is applied by building the matching tree.
- `layout-tree.ts` — the pure model: leaves are panes, splits are LINES ('h' side-by-side /
  'v' stacked) with fractional sizes. All mutations live here (split/remove/move/swap/
  serialize), DOM-free and normalize-guarded.
- `grid-layout.ts` — `GridLayout`: renders the tree as absolutely-positioned slots +
  per-seam drag **gutters** + focus tracking. Slot elements are **reused by pane id**
  across every mutation (template change, split, drag), so a pane's PTY is never killed
  by rearranging (only added/removed panes change).
- `index.ts` — exports the components (`workspace` composes one `GridLayout` per
  workspace; `layout` registers no UiFeature of its own).

## Behaviors (user contracts)
- **Resize**: every gutter is ONE seam of ONE line — dragging it resizes only the panes
  touching that seam, never a whole row/column of the workspace. Works for any tree,
  including former "ragged" counts (3/5/7…), which previously couldn't resize at all.
- **Add a terminal** (the layout popover's "New terminal" row, pane ⋯ menu split,
  Ctrl+Shift+D, palette): the new pane
  joins the focused pane's line (auto direction: the pane's longer axis) and the line
  **re-equalizes** — every terminal in it gets an equal share. The new shell opens in the
  split pane's cwd.
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
- **Persistence**: the serialized tree (shape + sizes, ids renumbered to slot order)
  rides `WorkspaceStateMeta.layout`; restore re-applies it exactly, falling back to the
  template grid on any doubt.

## Decoupling (guardrail)
`layout` **does not import `terminal`**. It publishes its slots via `@ui/core/layout/slots`
(`publishSlots` / `onSlots`, keyed by `PaneId` from `@contracts`); the `terminal` feature
subscribes and mounts a `TerminalPane` into each slot. Split requests flow the other way
as bubbling DOM events (`mogging:split-pane`), handled by the `workspace` controller —
it must seed the new pane's cwd before the slot exists. The features meet only at that
port + `@contracts`. See `docs/04-adding-a-feature.md`.

## Perf
WebGL renderer per pane (falls back to DOM if a GPU context can't be created — Chromium
caps ~16 live WebGL contexts, so 16 panes is the budget edge; `MAX_PANES` enforces it).
Scrollback is capped per pane; the cursor blinks only in the focused pane to cut idle
repaints. Geometry is one JS pass per mutation/resize (rects set as inline px; a
`ResizeObserver` on the grid re-derives them, including the 0→W flip when a hidden
workspace is revealed).
