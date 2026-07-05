Agents build web things; users alt-tab to see them. Make the browser a
**toggleable right DOCK** — chrome beside the grid, not a tenant of it: preview
what the agent built while EVERY terminal stays visible and interactive. The
placement is a deliberate design call: the browser is a viewer of the agents'
output, not a peer — like the rail and the board, it's a view. It also pins
the WebContentsView to ONE stable rect (toggle/resize only) instead of chasing
a live grid cell through zoom/expand/switch churn, and it leaves the grid
model PTY-only: no pane-kind forks in layouts, templates, restore, or pane
ids. Accepted tradeoff: exactly one in-app browser (comparisons use the system
browser; a pop-out can be earned later). It is a WINDOW, not an agent: it
brokers nothing.

## Steps
1. **The dock**: `#browser-dock` right of `#content` — toggle via a titlebar
   icon (right cluster), `Ctrl+Shift+B`, and a palette command. Width-adjustable
   drag handle (min 320px, max 60vw; width persisted). The grid simply NARROWS
   (flex) and pane fit re-runs — pane ids, layouts, and templates untouched.
2. **The view**: renderer can't host WebContentsView — MAIN owns it.
   `BrowserChannels = { open, navigate, close, bounds, state }`: the renderer
   reports the dock rect (ResizeObserver → rAF-throttled `bounds`); `state`
   pushes url/title/canGoBack/loading to the dock header.
3. **Dock chrome**: back/forward/reload, a URL bar (Enter navigates), a
   loading bar, open-in-system-browser, and close (= toggle). The CHROME paints
   instantly on toggle — the perception claim lives on the chrome; the page
   load is async behind the loading bar.
4. **Per-workspace memory, hot-path-free**: each workspace remembers its LAST
   preview URL (settings-store KV `browser.lastUrl.<workspaceId>` — no manifest
   column). Switching workspaces NEVER navigates (no reload churn on the
   perception hot path): when the active workspace's remembered URL differs
   from the shown one, the header offers a one-click "open this workspace's
   preview" chip. Dock open/width restore across relaunch.
5. **Safety posture**: `sandbox: true`, no preload/nodeIntegration,
   `setWindowOpenHandler` → deny + `shell.openExternal`, permission requests →
   deny-all. Default session, NOTHING injected or read by us: no auth
   automation, no cookie access, no history beyond the per-workspace last URL.
   http(s): only; anything else → shell.openExternal.
6. **Perf**: dock closed → `view.setVisible(false)`; MILESTONE + PERCEPTION
   re-run and hold unchanged (the grid narrows — fit must stay budget-clean).
7. **Smoke** (`MOGGING_BROWSER`): toggle on → view bounds match the dock rect
   (±2px), grid narrowed, pane count unchanged; navigate to a smoke-served
   `http://localhost` page (node http server in the smoke — no external
   network); header url/title update; `window.open` denied; drag-resize moves
   bounds; toggle off hides the view + re-widens the grid; width/lastUrl
   round-trip through the store.

## Files
- `src/contracts/ipc/browser.ipc.ts` + channels · `src/main/browser-dock.ts` +
  `src/main/index.ts` · `src/ui/features/browser/` (dock chrome + toggle) ·
  `src/ui/shell/app-shell.ts` (dock slot) · settings-store KV only ·
  `src/main/browser-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- One keystroke shows localhost beside the FULL grid; terminals stay visible
  and interactive while browsing; toggle off returns every pixel to the panes.
- Dock width + per-workspace last URL survive a relaunch. Both perf gates
  unchanged. Zero changes to the grid model, pane ids, or layout templates.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_BROWSER` green isolated; MILESTONE + PERCEPTION + PANEOPS still
  green; gallery states for the dock (open, loading, both themes).

## Guardrails
- ADR 0002 absolute: no session injection, no credential autofill, no cookie
  reading, no auth flows automated. The dock is chrome around the user's browsing.
- URLs are user content: never telemetry/logs (a `browser_dock_opened` count is fine).
- The grid stays PTY-only — if a future need wants a browser IN the grid, that
  is a new design call, not scope creep here.
- No new dependencies; no protocol v3 changes; renderer never gets the WebContents.
