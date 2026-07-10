The explorer becomes a SURFACE (Phase-11/03): a right-side dock hosting the
02 tree, rooted at the active workspace's folder, toggled from the FAR
RIGHT of the app bar — `panel-right` mirroring the rail's `panel-left`. The
browser dock is the precedent throughout.

## Steps
1. **The `titlebarEnd` slot**: the right cluster appends `(left, right,
   board, settings)` (`titlebar.ts:92`) — add a third dynamic slot
   appended AFTER settings, exposed as `ctx.titlebarEnd` (`app-shell.ts`
   + `ShellContext`). The blanket `#titlebar button` no-drag rule covers
   it; stay clear of `--controls-reserve`.
2. **The dock** (`src/ui/features/explorer/index.ts`, UiFeature in
   `ui/index.ts`): `<aside class="explorer-dock">` appended LAST into
   `#main` — outermost right; with the browser dock open the order is
   `#rail | #content | .browser-dock | .explorer-dock`. Width 300
   default, clamped [240px, 40vw]; `#content` keeps ≥ 480px with both
   docks open; `.explorer-dock-handle` pointer-capture drag
   (`browser/index.ts:314`). Header: workspace color dot + name,
   middle-truncated root path (`title` = full), `IconButton`s refresh ·
   collapse-all · show-hidden · close. Body: the 02 tree, `list`
   injected via `explorer.client.ts`.
3. **Rooting + per-workspace memory**: subscribe `workspace-info-port`
   (`onWorkspacesChange`) — root = the active workspace's `cwd`; keep
   `{ expandedDirs, scrollTop, selection }` per workspace id so switching
   re-roots from memory inside the 100ms budget; empty/missing `cwd` →
   house `EmptyState`, zero listing calls. Soft "you are here": when the
   focused pane's cwd (pane-cwd port) sits under the root and its row is
   VISIBLE, tint it — no auto-expand, no scroll steal.
4. **One toggle, four doors**: an `IconButton` (`panel-right`, NEW glyph
   in `icons.ts`) in `ctx.titlebarEnd`, `is-active` synced;
   `Ctrl+Shift+E` keydown (capture; free — taken: B/U/D/G/C/V);
   `setCommands('explorer', …)` for the palette; a Tools row in
   `core/commands/shortcuts.ts` (one source: `?` overlay + Settings).
   Toggling NEVER moves focus out of a pane.
5. **Persistence**: KV via `SettingsStore.getSetting/setSetting` through
   `src/main/explorer.ts` — `explorer.open`, `explorer.width` (debounced,
   the `browser.width` precedent), `explorer.showHidden`; restored on
   boot before the dock first paints.
6. **Gallery + EXPLORER smoke** (`MOGGING_EXPLORER`): gallery `part()`s,
   both themes (staged fixture tree — no username in visible crumbs).
   Smoke: (a) button, shortcut, palette all toggle; `is-active` tracks;
   (b) the button is the RIGHTMOST interactive in `#titlebar` (right of
   Settings), hit-testable; (c) width drag → clamped,
   persisted, KV read-back restores; (d) workspace switch → correct
   re-rooted tree, remembered expansion, ≤ 100ms; (e) no-cwd workspace →
   EmptyState, zero `list` calls (spy); (f) focus stays in the active
   pane across toggles; (g) closed → zero listing traffic. Verdict
   `out/explorer-result.json`.

## Files
- `shell/titlebar.ts` · `shell/app-shell.ts` · `feature-registry.ts` ·
  `src/ui/features/explorer/` ·
  `components/icons.ts` (panel-right) · `core/commands/shortcuts.ts` ·
  `src/main/explorer.ts` (KV) · global.css ·
  `src/main/explorer-smoke.ts` · dispatch · qa-smokes row · gallery

## Definition of Done
- One click or keystroke opens the workspace's folder in a pretty right
  sidebar; width + open-state survive relaunch; per-workspace expansion
  survives switching; the sweep count grows by one.

## Checks that must be green
- typecheck 0; build ok; static gates; full local sweep; PERCEPTION +
  MILESTONE re-run.

## Guardrails
- CHROMEUX, DOCKUX, UXMILESTONE green UNMODIFIED — the chip ladder and
  dock possession guard stay undisturbed.
- Tokens only; AA on header inks; both themes staged.
- No liveness (04), no git (05), no actions beyond expand/collapse (06).
