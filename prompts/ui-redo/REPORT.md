# UI/UX Redo — delivery report

Full redesign of MoggingLabs Workspace: every screen, component and interaction,
rebranded from green to the logo's orange (`#FD8D03`), wired to the real contracts/IPC,
holding every architecture/auth boundary and the 16-agent perf budget. Built vanilla
(TS + DOM factories, no framework), per the brief.

## Screens (inspiration → shipped → beyond)

**A · Home/Launcher** (`Launcher Screen.png`, net-new — `src/ui/features/home/`)
Brand hero (MW logo + wordmark + real tagline *"Your keys, your CLIs — no subscription
to us."*), primary **New workspace** (Ctrl+T) + **Quick terminal**, one-click **Recent
workspaces** (new persisted `recents` contract; switches to an already-open workspace
for the same folder instead of duplicating), **Presets** (open the wizard pre-seeded),
keyboard-hint bar. First-run and returning states both designed.
*Beyond:* no fake sibling-product tiles (honest scope); recents actually restore layout
+ folder + agent lineup. *Deviation (deliberate):* fresh boot lands in the grid, not
Home — a terminal must never put a lobby between you and a prompt (also keeps the Phase-0
smoke contract intact); Home is one keystroke away (Ctrl+Shift+H, rail button).

**B/C · Wizard — Start·Layout** (`Configure Workspaces.png`,
`workspace-configuration-of-working-directory.png`, net-new — `src/ui/features/wizard/`)
3-step stepper (done=check, current=orange halo). Working-folder picker: native browse
via the new `workspace:browseDir` channel (main-process dialog), recent-folder rows,
**soft git validation** (branch + dirty chip via `git:query`; "no repo — fine" is a
neutral note, never a block). Layout step: tiles are **true miniatures** of each grid
(1/2/4/6/8/9/12/16) + live preview caption. Step state persists across Back; Enter
advances; default grid size comes from Settings.

**D · Wizard — Agents** (`Terminals-Configuration-after-Workspace-Configuration.png`)
Roster from the real `agents:detect` (Claude Code, Codex, Gemini, Aider, OpenCode;
uninstalled rows disabled with a "not found on PATH" pill), per-agent steppers clamped
to remaining capacity, fill meter ("4 / 8 · 4 empty"), quick-fills (Fill all / One of
each / Split evenly / Clear — all reversible), **mini grid preview of which tile gets
which agent**, custom-command row (`custom:<cmd>` provider), presets (apply/save/delete
via `templates:*`), and both **Skip — no agents** and **Launch N terminals** as
first-class actions. BYO-auth honored: a single reassurance line, zero credential UI.
Launch resolves through `templates:resolve` → one PTY per pane → agent CLIs launched
into their panes (existing 06b path).

**E · Live grid** (`terminals-visually-…-outline-highlight[-2].png`, restyled —
`terminal-pane.ts`, `grid-layout.ts`)
Each pane: slim header (editable title = agent label, read-only git chip ⎇branch+dirty,
OSC agent-state dot, zoom) over the xterm body. **Selected pane = brand-orange ring**
(1px border + 1px halo + soft glow — pure paint, GPU-cheap). Drag-resize gutters kept;
added **keyboard pane nav** (Ctrl+Alt+arrows) and **zoom** (Ctrl+Shift+Enter /
double-click header button) — zoomed siblings hide and release WebGL via the existing
managed leasing. Focus-follows-click and the focus port now give the terminal real
keyboard focus. WebGL leasing, OSC-133 blocks, `mogging notify`, cursor-blink policy,
10k scrollback: all preserved. *Deviation:* per-pane split/close stayed at grid level
(the template model owns pane count); header ships title/git/state/zoom.

**F · Workspace rail** (`workspaces-visuals-…-number-of-panes-that-need-attention.png`,
horizontal bar → left vertical rail — `workspace/controller.ts`, `workspace/index.ts`)
Per workspace: accent icon (8 curated AA hues; brand-orange deliberately last), name
(F2/double-click rename), **live numeric attention count** (loud orange pill, pulsing,
paired with a number — never color alone), quiet pane-count, hover close, drag-reorder,
keyboard select (Enter/Space, Ctrl+1..9). **Current workspace = brand-orange outline**;
background attention keeps the latched orange ring (`data-attention` semantics
unchanged — asserted by the attention/milestone smokes). Collapsible to icon width
(Ctrl+Shift+B) with attention counts still visible. Event-driven throughout (attention
port), zero polling.

**G · Titlebar** (`Application-header-top-bar.png`)
Slim header: rail toggle · brand · **Commands** trigger (Ctrl+K) · layout popover ·
launcher/state chips. *Deviation:* native OS window frame kept (identical Win/Mac
behavior beats frameless chrome; no main-process window rework).

**Plus:** **Command palette** (Ctrl+K — every action: workspaces, layouts, themes,
panes, wizard, settings), **Settings** (theme System/Midnight/Light/Nord/Solarized,
default wizard grid, telemetry consent — honest about the current no-op adapter,
ADR 0005), **attention toasts** for background panes with one-click "Go"
(throttled 20s/pane, event-driven off `terminal:state`).

## Design system

- `global.css` rebuilt into a token system: brand-orange ramp (50–900 from the logo),
  dark-first neutrals, semantic colors (`--success` exit-0, `--danger` non-zero,
  `--warning`, `--attention`), 4-based spacing, radii, elevation, 120/200 ms motion with
  `prefers-reduced-motion`, thin scrollbars, `:focus-visible` ring. Legacy 7 vars
  aliased onto tokens (nothing broke mid-migration).
- Themes write **neutral tokens only** — the orange accent + semantics stay constant, so
  every palette still reads as us; xterm themes are **derived from the same tokens**
  (panes always match chrome). Light theme AA-corrected (`accent-ink #a55800` ≈ 5.2:1,
  `text-lo #666b74` ≈ 4.9:1); System theme follows `prefers-color-scheme` live.
- Component library (`src/ui/components/`): 15 vanilla factories + a 30-icon inline SVG
  set (Lucide path data, `currentColor`) — no framework, nothing in the hot terminal path.

## Architecture (boundaries intact)

- `@ui` imports only `@contracts` + browser APIs — verified by grep (no `electron`,
  `node-pty`, `@backend`, `node:*`).
- New cross-feature seams are **ports**, per the house pattern: `view-port` (Home/grid),
  `command-port` (palette), `workspace-info-port` (list + switcher), `wizard-port`
  (opener), `theme-state` (current theme). Features still never import each other.
- Contract extensions (the sanctioned way): `workspace:browseDir` channel (main-owned
  native dialog), `WorkspaceState.recents` (+ `RecentWorkspace`), persisted through the
  existing key/value table — **metadata only, never credentials** (ADR 0002).
- Test-support: `MOGGING_USERDATA` env hook in main (smokes isolate their state;
  Electron ignores an `APPDATA` env override on Windows) + `scripts/qa-smokes.sh`
  (per-run fresh userData + fresh daemon, verdicts from result JSONs).
- Superseded and removed: horizontal `#workspace-bar`, layout-toolbar buttons, theme
  `<select>`, the `#template-dialog` provider-mix modal (wizard re-exposes the
  `__mogging.templates` dev contract the template smoke drives).

## Gates

- `npm run typecheck` → 0 · `npm run build` → ok · boundary grep clean · zero "Bridge*"
  identity in `src/` (one legacy comment scrubbed).
- Smoke sweep (isolated, fresh state per run — `scripts/qa-smokes.sh`): **9/9 PASS** —
  SMOKE · MULTIPANE · ATTENTION · BLOCKS · GIT · NOTIFY · MILESTONE · TEMPLATE A ·
  TEMPLATE B.
- Perf (`MOGGING_MILESTONE`, 16 live panes under ANSI torrent): stress avg **135 fps**
  (budget ≥30; pre-redo baseline 135.3), worst gap **41.7 ms** (≤150; baseline 48.6),
  idle worst gap 13.9 ms, heap **32 MB** (≤300; baseline 28 — the whole redesign costs
  ~4 MB), WebGL **16/16 visible · 16/16 released hidden · 16/16 re-acquired**, attention
  badges 4/4 end-to-end, tab ring latch + clear-on-focus ✓. **Perf-neutral redesign.**
- Visual: `out/shot.png` (fresh-boot capture of the redesigned shell). One bug found by
  the capture and fixed: author `display` rules were overriding the UA's
  `[hidden]{display:none}`, leaving an empty attention pill visible on idle rail items —
  fixed with a global `[hidden]{display:none !important}` guard.

## Follow-up round (launcher-first + type + chrome + artifact hardening)

Direction change requested after the first delivery — all landed and re-verified:

- **Launcher-first boot.** The app now ALWAYS opens on Home: `view-port` defaults to
  `'home'`; restore re-activates the last workspace *without* revealing its grid
  (`switch(id, { reveal:false })`); closing the last workspace returns Home; no phantom
  "Workspace 1" is auto-created — the launcher is the first-run empty state. Every
  smoke that assumed a boot-time pane now provisions its own workspace (SMOKE,
  MULTIPANE, ATTENTION, BLOCKS, NOTIFY, MILESTONE, TEMPLATE — updated intentionally).
- **Recent projects.** Recents are now the **five most recent project directories
  worked on**, touched on OPEN (wizard, `mogging .`, reopen) and on close (final
  layout), deduped by folder (`RecentWorkspace.lastUsedAt`). Home's tiles reopen them
  one-click (or switch, if already open).
- **JetBrains Mono everywhere.** Bundled `@fontsource-variable/jetbrains-mono` (one
  variable face, 40 kB woff2, CSP-clean); `--font-ui` = `--font-mono` = JetBrains Mono
  with a deliberate mono hierarchy (700 tight-tracked headers, 600/500 labels, 400
  body, wide-tracked uppercase section labels); terminals switched to the same face;
  the renderer gates mount on `document.fonts.load` so xterm never measures a fallback
  font (no metric-swap artifacts).
- **Organic chrome.** Frameless window (`titleBarStyle: 'hidden'` + Windows
  `titleBarOverlay`, macOS `hiddenInset` traffic lights): the brand moved into the
  full-height rail's top corner (a drag region), the header strip sits on the app
  surface (drag region, `env(titlebar-area-width)` clearance), and a new
  `shell:titlebarOverlay` channel keeps the native window-control overlay tinted to
  the active theme. Nothing reads as a bar glued on top.
- **Artifact hardening — a real bug found and fixed.** New env-gated
  **`MOGGING_FLICKER`** smoke: 16 rapid workspace switches + 6 zoom churns over 8
  stamped live panes, sampling rAF gaps, then asserting content integrity (own marker
  only, buffers kept), WebGL recovery (8/8), frame budget (≤150 ms) and zero renderer
  errors. First run FAILED honestly: revealing a workspace attached all its WebGL
  addons in one tick (**326 ms** stall). Fix: GL attach/detach now go through a
  debounced, app-wide **one-job-per-frame queue** — rapid flips keep contexts warm
  (pure show/hide), sustained hides still release within the milestone's asserted
  window. Result: churn worst gap **326 → 76.4 ms** (0 frames >100 ms), zoom churn
  **146 → 13.8 ms**; milestone still green (125 fps stress, 31 MB heap, 16/16 GL
  lease/release/re-acquire).
- **Final board:** typecheck 0 · build ok · SMOKE, MULTIPANE, ATTENTION, BLOCKS, GIT,
  NOTIFY, MILESTONE, **FLICKER**, TEMPLATE A+B — all PASS on isolated fresh state.
  `out/shot.png` = the first-boot Home hero.

## Round 3 (terminal chrome: square panes · scrollbar · per-terminal top bar)

- **Square terminals.** Pane corners are hard 90°; separation is a 2px recessed frame +
  5px gutter seams (`--bg-inset` showing through) — adjacent panes can never read as one
  line of text, and no more chrome than that.
- **Hover-only scrollbar** (copied from `slick-slider.png`): slim rounded neutral thumb,
  invisible track; in terminals it appears only while the cursor rides the pane's
  right-edge strip (a mousemove hot-zone class — no per-frame work) and goes solid under
  the cursor. Token-driven (`--text-lo` mixes), so it follows every theme; app-wide
  scrollbars share the same language.
- **Terminal top bar** (exact take on `terminal-top-bar.png`): LEFT = ✳ state glyph +
  the title the agent gives the pane (wired to xterm `onTitleChange` — OSC 0/2, i.e.
  the task Claude Code/Codex put in the window title), falling back to the launch label
  then "Terminal N"; CENTER = the read-only git branch chip (existing 2/03 machinery,
  hidden outside repos); RIGHT = `[⋯ menu][⤢ expand-full][↔ expand-width][↕
  expand-height][× close]`. The ⋯ menu: Rename, Clear terminal, Copy working directory,
  and a "Launch <agent> here" entry per installed CLI (via the command port).
- **Expand modes + per-pane close** (`GridLayout` generalized): `full` = whole
  workspace (old zoom), `col` = full height keeping width, `row` = full width keeping
  height — covered siblings hide and release WebGL via the managed leasing. Close kills
  that pane's PTY (slots port) and reflows the remaining panes — uniform template counts
  keep drag-gutters; ragged counts lay out on an LCM-12 grid with even spans (drag pauses
  until a template is re-applied). Closing the last pane closes the workspace. Attention
  scans now walk live `paneIds()` (closed slots can't mask a pane needing you).
- **Shading system** (consistent per theme): rail `--bg-surface` · app header
  `--bg-app` · grid seams `--bg-inset` (recessed) · terminal body `--bg-app` · pane bars
  `--bg-surface` (elevated) · menus/modals `--bg-elevated`.
- **Fidelity pass vs `terminal-top-bar.png`:** the pane title renders neutral (the bar's
  only color accent is the state glyph, as in the reference), and the branch chip is a
  soft borderless chip with a real branch ICON + name (was a bordered pill with a `⎇`
  text glyph). GIT smoke re-passed; `out/shot.png` (grid mode now seeds the repo cwd)
  shows all four bars live with `⑂ main •` centered.
- **Verified:** typecheck 0 · build ok · **11/11 smokes PASS** on isolated fresh state —
  the 10 standing gates (incl. MILESTONE perf + FLICKER churn against the new grid) plus
  a new **`MOGGING_PANEOPS`** smoke that drives the top bar's headline actions
  end-to-end: expand-vertical (full-height span, underlying pane hides, restore),
  expand-horizontal (full-width span, row-mate hides, restore), and close (PTY disposed
  through the slots port, ragged 3-pane reflow, survivors' buffers intact).
  `out/shot.png` (`MOGGING_SHOT=grid`) shows the 4-pane grid with the new bars live.

## Round 4 (telemetry end-to-end + Phase 3 planning)

- **Telemetry is fully wired** (observability/00-02 executed; ADR 0005 honored):
  consent (error reporting + product analytics, both **opt-in, default OFF**) + an
  anonymous install id persist in the main-side settings store; the renderer gets its
  config over new `telemetry:*` channels and re-inits LIVE on change; `DO_NOT_TRACK`
  always wins. **Sentry** (`@sentry/electron`) runs in both processes (renderer
  auto-forwards to main; native crashes included; `sendDefaultPii:false` + scrubber;
  consent revoke disables the client immediately). **PostHog** (`posthog-node`) runs in
  MAIN only — no autocapture, no session recording, no person profiles — fed by ~18
  curated UI events forwarded over the channel through a main-side sanitizer
  (dot.namespaced names, primitive props, bounded sizes). Vendors activate only when
  consented AND keyed (`SENTRY_DSN` / `MOGGING_POSTHOG_KEY`); with defaults, the entire
  pipeline is provably inert (canary smokes green on fresh state).
- **Event taxonomy** (counts/booleans/ids ONLY — never text, paths, commands, titles):
  app.launched · home.opened/recent_reopened/preset_opened · wizard.opened/completed ·
  preset.applied/saved · workspace.created/closed · layout.applied · pane.closed/
  expanded/renamed · agent.launched {provider} · palette.opened/command_run {family} ·
  attention.toast_shown/toast_go · theme.changed · settings.opened · gl.context_lost.
- **Settings** now has the real consent UI (two toggles over IPC, honest copy).
- **Phase 3 planned + prompt pack written** (`prompts/phase-3/`, house format, roadmap-
  aligned "Orchestration"): 01 control API core (`mogging list/send/send-key/capture`),
  02 layout ops, 03 worktree-per-agent, 04 pre-ship diff review (secret-redacting,
  injection-resistant), 05 Kanban board → agent-in-pane, 06 orchestration milestone —
  each with its own env-gated smoke and the standing perf budget as a gate.

## Round 5 (field-report fixes: width bug, top bar, rail sizing)

- **Terminal width bug — instrumented, root-caused, fixed.** A geometry probe
  (`MOGGING_SHOT=grid` now also writes `out/shot-probe.json`) showed a 57 px dead strip:
  panes measured cell size inconsistently around JetBrains Mono activation. Fix: on
  `document.fonts.ready` every pane invalidates xterm's char-metrics cache (fontFamily
  toggle) + refits, and panes refit on reveal. Probe after: 55 cols × 7.8 px fills the
  viewport minus only the standard scrollbar reserve.
- **Pane bar alignment** — probe-verified: actions flush right, branch chip dead-center.
- **Rail** grew to 288 px with 14 px names + 30 px icons (readability).
- **Top bar** is a classic full-width bar: logo · name · **v0.1.0** (live from main)
  left; layout · Commands ⌘K · rail toggle · **settings icon** · native window controls
  right. macOS traffic-light clearance kept.
- **“Launch agent” titlebar button removed with zero traces** (grep-verified); the
  agents feature is headless (detection + palette/pane-menu commands + wizard port).
  The redundant IDLE titlebar chip went with it; STATE + AGENTLAUNCH smokes were
  repaired to the new surfaces (+ launcher-first preambles) instead of left broken.
- **Verified:** typecheck 0 · build ok · SMOKE, PANEOPS, ATTENTION, STATE, AGENTLAUNCH
  all PASS isolated · fresh `out/shot.png` shows every fix live.

## Round 6 (perception budget: anchored, optimized, enforced)

- **`docs/07-perception-budget.md`** — every visual-latency number now anchors to what
  humans notice (Card/Nielsen 100 ms "instant" ceiling; ~2 dropped frames = visible
  hitch; 50–60 ms keystroke-echo threshold; ~50 ms wrong-state = flicker; 1 s flow
  break), with hard budgets at the notice threshold and targets at ~2× headroom:
  interactive actions ≤ 100 (target 50), echo ≤ 60 (target 40), ZERO >100 ms frames
  during interaction or torrent.
- **Optimizations to sit under it:** GL contexts stay warm for 1.5 s after a pane
  hides (workspace flips while interacting are pure show/hide — no shader/atlas cost
  mid-interaction; background workspaces still free contexts promptly, and the
  context-loss self-heal guards the cap); workspace switching no longer rebuilds
  command-palette lists (signature-skipped republish).
- **Enforcement:** new **`MOGGING_PERCEPTION`** smoke measures the app as a human
  feels it — double-rAF action→painted latency for workspace switch / Home⇄grid /
  zoom, keystroke→echo median through the real daemon round-trip, and zero->100 ms
  frames across a 12-flip churn and a 2 s 8-pane torrent. **`MOGGING_FLICKER`'s frame
  gate tightened 150 → 100 ms** (the perception number; docs/05's 150 stays as the
  machine floor in MILESTONE).

## Known deviations / notes

1. ~~Boot lands in the grid~~ — superseded: boot is launcher-first (follow-up round).
2. Pane rename is runtime metadata (pane-meta port), not persisted across restarts.
3. Per-pane split/close not in the pane header (grid templates own pane count).
4. The dev-machine app-settings DB accumulates smoke workspaces when smokes run
   non-isolated (pre-existing situation); `scripts/qa-smokes.sh` now isolates.
5. Telemetry consent toggle stores locally and gates future wiring; adapter today is
   no-op (truthfully labeled).
