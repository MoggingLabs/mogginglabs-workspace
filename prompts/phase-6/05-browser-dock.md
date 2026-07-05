Agents build web things; users alt-tab to see them. Make the browser a
**toggleable right DOCK** — chrome beside the grid, not a tenant of it:
preview what the agent built while EVERY terminal stays visible. Deliberate
design call: the browser is a viewer of the agents' output, not a peer (like
the rail and board, it's a view); the WebContentsView pins to ONE stable rect,
not a live grid cell; the grid stays PTY-only — no pane-kind forks. Accepted
tradeoff: one in-app browser (comparisons use the system browser). It is a
WINDOW, not an agent: it brokers nothing.

## Steps
1. **The dock**: `#browser-dock` right of `#content` — toggled by a titlebar
   icon (right cluster), `Ctrl+Shift+B`, and a palette command; drag-resizable
   (min 320px, max 60vw, width persisted). The grid simply NARROWS (flex) and
   pane fit re-runs — pane ids, layouts, templates untouched.
2. **The view**: renderer can't host WebContentsView — MAIN owns it.
   `BrowserChannels = { open, navigate, close, bounds, state }`: the renderer
   reports the dock rect (ResizeObserver → rAF-throttled `bounds`); `state`
   pushes url/title/canGoBack/loading to the dock header. Split main-side into
   `dock` (view/bounds) + `driver` (navigate/read/act verbs) — the driver is
   the seam 05b hands to AGENTS; build it verb-shaped now.
3. **Dock chrome**: back/forward/reload, URL bar (Enter navigates), loading
   bar, open-in-system-browser, close (= toggle). The CHROME paints instantly
   on toggle — the perception claim lives there; page load is async.
4. **Per-workspace memory, hot-path-free**: each workspace remembers its LAST
   preview URL (settings-store KV `browser.lastUrl.<id>` — no manifest column).
   Switching workspaces NEVER navigates (no reload churn on the hot path):
   when the active workspace's remembered URL differs from the shown one, the
   header offers a one-click "open this workspace's preview" chip. Dock
   open/width restore across relaunch.
5. **Safety posture**: `sandbox: true`, no preload/nodeIntegration,
   `setWindowOpenHandler` → deny + `shell.openExternal`, permission requests →
   deny-all. Default session, NOTHING injected or read by us: no auth
   automation, no cookie access, no history beyond the per-workspace last URL.
   http(s): only; anything else → shell.openExternal.
6. **Perf**: dock closed → `view.setVisible(false)`; MILESTONE + PERCEPTION
   hold unchanged (the grid narrows — fit must stay budget-clean).
7. **Smoke** (`MOGGING_BROWSER`): toggle on → view bounds match the dock rect
   (±2px), grid narrowed, pane count unchanged; navigate to a smoke-served
   `http://localhost` page (smoke-local node http server); header url/title
   update; `window.open` denied; drag-resize moves bounds; toggle off hides
   the view + re-widens the grid; width/lastUrl round-trip through the store.

## Files
- `src/contracts/ipc/browser.ipc.ts` + channels · `src/main/browser-dock.ts` +
  `src/main/index.ts` · `src/ui/features/browser/` ·
  `src/ui/shell/app-shell.ts` · settings-store KV only ·
  `src/main/browser-smoke.ts` · `scripts/qa-smokes.sh`

## Definition of Done
- One keystroke shows localhost beside the FULL grid; terminals stay
  interactive while browsing; toggle off returns every pixel to the panes.
- Width + per-workspace last URL survive relaunch; both perf gates unchanged;
  zero grid-model changes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- `MOGGING_BROWSER` green isolated; MILESTONE + PERCEPTION + PANEOPS still
  green; dock gallery states, both themes.

## Guardrails
- ADR 0002 absolute: no session injection, credential autofill, cookie
  reading, or automated auth. The dock is chrome around the user's browsing.
- URLs are user content: never telemetry/logs (an opened-count is fine).
- The grid stays PTY-only — a browser IN the grid would be a new design call.
- No new deps; no protocol v3 changes; renderer never gets the WebContents.
