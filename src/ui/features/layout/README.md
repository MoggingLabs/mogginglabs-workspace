# `ui/features/layout` — split/grid pane layout

Replaces the Phase-0 single hardcoded pane with a resizable **grid of slots** (Phase-1/04).

- `templates.ts` — pane-count → grid dims (1/2/4/6/8/9/12/16, all exact grids).
- `grid-layout.ts` — `GridLayout`: renders a CSS grid + drag-resize **gutters** + focus
  tracking. Slot elements are **reused by pane id** across template changes, so a pane's PTY
  isn't killed when you switch templates (only added/removed panes change).
- `index.ts` — the `UiFeature`: a template toolbar + the grid; a dev handle for the smoke.

## Decoupling (guardrail)
`layout` **does not import `terminal`**. It publishes its slots via `@ui/core/layout/slots`
(`publishSlots` / `onSlots`, keyed by `PaneId` from `@contracts`); the `terminal` feature
subscribes and mounts a `TerminalPane` into each slot. The two meet only at that port +
`@contracts`. See `docs/04-adding-a-feature.md`.

## Perf
WebGL renderer per pane (falls back to DOM if a GPU context can't be created — Chromium caps
~16 live WebGL contexts, so 16 panes is the budget edge). Scrollback is capped per pane; the
cursor blinks only in the focused pane to cut idle repaints.
