# 02 — Control API layout ops: `mogging open / layout / focus / expand / close-pane`

**Prereq:** `01` green. **Shared context:** `prompts/phase-3/README.md` +
`src/ui/core/` ports + `src/main/deep-link.ts` (the `workspace:openCwd` relay pattern).

## Goal
Layout is renderer state (grids live in `@ui`), so layout verbs ride a MAIN-process
relay to the UI — the same pattern `mogging .` already uses — while pane verbs (01) stay
on the daemon. After this step a script can build the whole wall: open a workspace, set
the grid, focus/expand a pane, close one.

## Steps
1. **Contracts** (`src/contracts/ipc/`): add `ControlChannels = { command:
   'control:command' }` (main → renderer, `on`) with payload
   `ControlCommand = { verb: 'open'|'layout'|'focus'|'expand'|'close-pane',
   cwd?, panes?, paneId?, mode? }` — a closed union, no free-form strings reach the UI.
2. **Main**: extend the single-instance/deep-link entry (`src/main/deep-link.ts` +
   `src/main/index.ts`): `mogging` invokes the app with `--control '<json>'` (second
   instance → `app.requestSingleInstanceLock` hands argv to the primary, exactly like
   `mogging .`); main validates the verb union and forwards over `ControlChannels.command`.
3. **Renderer**: the workspace feature subscribes (it already owns the controller):
   `open` → `openForCwd(cwd)` (+ optional `layout`); `layout` → `applyTemplate(panes)`;
   `focus` → focus port + reveal; `expand` → `expandPane(paneId, mode)`;
   `close-pane` → `closePane(...)` (last pane = close workspace — existing semantics).
4. **CLI** (`bin/mogging.mjs`): `open <dir> [--panes N]`, `layout <N>`,
   `focus <pane>`, `expand <pane> [full|col|row]`, `close-pane <pane>` — each spawns/
   signals the app via the deep-link path; exit non-zero if the app isn't running and
   `--no-launch` was passed.
5. **Smoke** (`MOGGING_CONTROL2`): boot isolated → child-process the CLI: `open $TMP
   --panes 4` → dev handles report a 4-pane workspace at that cwd; `expand <base+1>
   col` → covered sibling hidden; `close-pane` → 3 panes remain; `focus` moves the
   `.layout-slot.focused` ring. Result JSON + qa-smokes entry.

## Files
- `src/contracts/ipc/channels.ts` (+ `control.ipc.ts`) · `src/main/deep-link.ts`,
  `src/main/index.ts` · `src/ui/features/workspace/index.ts` (subscriber)
- `bin/mogging.mjs` · `src/main/control2-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- A shell script assembles a working wall (open → layout → focus → expand) with zero
  clicks, on a cold OR running app; every verb validated main-side before the UI sees it.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- `MOGGING_CONTROL2` green isolated; `MOGGING_ATTENTION` + `MOGGING_PANEOPS` still green
  (same controller paths).

## Guardrails
- Verbs are a closed union — validate in MAIN, drop anything else (the renderer never
  parses raw CLI input).
- Reuse the single-instance argv relay; do NOT add another IPC listener surface.
- `open` paths go through the exact `openCwd` normalization `mogging .` uses.
