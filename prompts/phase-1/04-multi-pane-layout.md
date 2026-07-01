# 04 — Multi-pane grid + layout feature

**Prereq:** `03` green. **Shared context:** see `README.md`.

## Goal
Replace the Phase-0 single hardcoded pane with a real **layout** feature: split/grid
templates (1/2/4/6/8/…/16), drag-resize, and focus — multiple `TerminalPane`s (distinct
pane ids) hosting shells/agents concurrently in one workspace.

## Steps
1. **`src/ui/features/layout/`** — a layout tree (splits/tabs), pane templates, drag-resize
   handles, focus management; renders slots.
2. **Terminal into slots** — the `terminal` feature mounts a `TerminalPane` per slot
   (remove the hardcoded `new TerminalPane(1, host)`); allocate unique pane ids; each id ->
   its own backend PTY. (Backend `PtyService` already keys on pane id.)
3. **Concurrency** — verify N panes stream simultaneously with no cross-talk (each pane's
   data routes by id).
4. **Perf** — WebGL per pane; set a **perf budget** (e.g. 16 panes @ 60fps, capped RAM);
   throttle/virtualize background panes; cap scrollback.

## Files
- `src/ui/features/layout/**`, `src/ui/features/terminal/index.ts` (mount into slots),
  `src/ui/shell/app-shell.ts`, `src/ui/features/terminal/terminal-pane.ts` (id per pane).

## Definition of Done
- User can split into grid templates, drag-resize, and focus panes.
- >=8 panes each host a shell/agent concurrently, isolated (no cross-talk), smooth.

## Checks that must be green
- Multi-pane smoke: spawn N panes, each echoes a distinct marker; assert isolation +
  per-pane routing -> green.
- `npm run typecheck` -> 0; `npm run build` -> ok; boundaries clean.

## Guardrails
- Keep features decoupled — `layout` must not import `terminal` internals; communicate via
  slots + `@contracts`. (See `docs/04-adding-a-feature.md`.)
