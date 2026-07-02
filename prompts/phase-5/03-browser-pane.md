Agents build web things; users alt-tab to see them. Make a **browser a first-class
pane type**: a WebContentsView-backed pane with a URL bar, living in the same grid,
same workspace, same persistence — preview-what-the-agent-built without leaving the
wall. It is a WINDOW, not an agent: it brokers nothing.

## Steps
1. **Pane-kind seam**: today every slot is a terminal. Introduce
   `PaneKind = 'terminal' | 'browser'` — per-slot `kinds?` in `TemplateWorkspaceSpec`
   → meta → persistence (`pane_kinds` column, the paneCwds/roles/remotes pattern) →
   the `terminal` feature's slot consumer skips browser slots; a new
   `src/ui/features/browser/` feature claims them (same `.layout-slot` chrome:
   header, expand modes, close — reuse, don't duplicate).
2. **The view**: renderer can't host WebContentsView — MAIN owns it.
   `BrowserPaneChannels = { create, navigate, close, bounds, state }`: the renderer
   sends its slot's rect (ResizeObserver → `bounds`, throttled to rAF) and main
   positions a `WebContentsView` over the window at that rect; hide/show follows
   workspace switching (the slot reports visibility — reuse the IntersectionObserver
   pattern). `state` pushes url/title/canGoBack to the renderer header.
3. **Pane chrome**: header = back/forward/reload, a URL bar (Enter navigates;
   display-only origin emphasis), the standard expand/close cluster. New-pane entry
   points: wizard Layout step (a slot-kind toggle), pane ⋯ menu ("Open browser
   here…" replaces the slot), and `mogging open --browser <url>`? NO — control API
   stays v3 (guardrail); palette command "New browser pane" is enough.
4. **Safety posture**: `WebContentsView` with `sandbox: true`, no preload, no
   nodeIntegration, `setWindowOpenHandler` → deny (open externally via shell),
   permission-request handler → deny-all except clipboard-read prompt. Default
   session (normal cookies) but NOTHING injected or read by us: no auth automation,
   no cookie access, no navigation history persisted beyond the slot's LAST url
   (restored like cwd). http(s): only; anything else → shell.openExternal.
5. **Perf**: the view participates in the budgets — hidden workspaces call
   `view.setVisible(false)`; MILESTONE + PERCEPTION re-run and must hold unchanged.
6. **Smoke** (`MOGGING_BROWSER`): isolated boot → workspace with 1 terminal + 1
   browser slot → navigate to a local `data:`/`http://localhost` page served by the
   smoke (node http server) → assert: view exists + bounds match the slot rect (±2px),
   header url/title update, workspace switch hides/shows the view, `window.open` is
   denied (no new window), last-url restores after reload, close destroys the view.

## Files
- `src/contracts/ipc/browser.ipc.ts` + channels · `src/main/browser-panes.ts` +
  `src/main/index.ts` · `src/ui/features/browser/` · terminal feature slot filter ·
  wizard/palette/pane-menu touches · settings-store `pane_kinds` ·
  `src/main/browser-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- A browser pane lives in the grid like any terminal: resizes, expands, zooms,
  switches, persists its url, closes — and previews localhost next to the agent
  building it. Both perf gates unchanged.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_BROWSER` green isolated; MILESTONE + PERCEPTION + PANEOPS still green.

## Guardrails
- ADR 0002 absolute: no session injection, no credential autofill, no cookie
  reading, no auth flows automated. The pane is chrome around the user's browsing.
- URLs are user content: never telemetry/logs (a `browser_pane_opened` count is fine).
- No new dependencies; no protocol v3 changes; renderer never gets the WebContents.
