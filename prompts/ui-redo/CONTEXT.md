# UI/UX Redo — CONTEXT MASTER (read this in full before executing `GOAL.md`)

This is the **context brief** for a complete UI/UX redo of **MoggingLabs Workspace**.
It carries no task steps — it exists so the executing model gains the *full* picture of
what's being built, what already exists, and what "done" looks like, before it writes a
line of code. The runnable directive is `prompts/ui-redo/GOAL.md` (paste that as a
`/goal`); it points back here.

**Two framing rules that govern everything:**
1. **Understand before you touch.** Absorb this whole doc + the linked files first.
2. **Inspiration is a floor, not a ceiling.** The screenshots in `assets/Inspiration/`
   are from the **competitor we're built to beat**. Mine their patterns/IA, then exceed
   them and rebrand 100% to us. Never copy their name, logo, colors, or naming.

---

## 1 · What we're building

MoggingLabs Workspace is a cross-platform **Electron** desktop app that runs and
coordinates **many parallel AI coding-agent CLIs** (Claude Code, Codex, Gemini CLI,
Aider, OpenCode, …) as real PTY subprocesses, in a **fast multi-pane terminal**
(xterm.js + WebGL) with **persistent workspaces**. It hosts the user's *own* CLIs under
the user's *own* auth — **it never brokers provider auth** and takes no cut.

It's a neutral, local-first, non-copyleft rival to BridgeMind's **BridgeSpace**, winning
on: rendering reliability under many agents, identical Win/Mac behavior, strict
neutrality, scriptability, and an open/no-account posture. The Phase-2 wedge is **agent
awareness** — *"16 agents, see who needs you at a glance, nothing freezes."*

**Read for the full strategy** (do this):
- `README.md`
- `docs/00-vision-and-positioning.md`, `docs/02-mvp-and-roadmap.md`
- `docs/03-research-synthesis.md` (skim for the UX bar)
- `docs/adr/0001`…`0006` (Electron over Tauri; never broker auth; persistent PTY host;
  layered feature-sliced architecture; detached PTY daemon)

---

## 2 · Architecture & the boundaries you must never break

- `docs/01-architecture.md` — three tiers (renderer / PTY-host / main) + security
  hardening (`contextIsolation`, `sandbox`, no Node in the renderer).
- **Layering:** `@contracts` depends on nothing. `@backend` and `@ui` depend only on
  `@contracts`, **never on each other**. `main`/`preload`/`renderer` are the only
  composition root.
- **The UI layer stays Electron-free and Node-free.** No `import electron`, no
  `node-pty`, no Node built-ins in `src/ui/`. Everything privileged goes through the
  preload bridge. Extend data shapes **only** via `@contracts`.

**IPC surface:** the preload exposes exactly one global — **`window.bridge`** =
`{ invoke, send, on }`, allowlisted against `AllChannels`
(`src/contracts/ipc/channels.ts`). Channel groups you'll call from the UI:
`terminal:spawn|write|resize|kill|data|exit|state|cwd`,
`workspace:loadState|saveState|openCwd|attention`, `agents:detect|command`,
`templates:list|resolve|save|remove`, `git:query|watch|unwatch|change`,
`clipboard:write|read`. Domain types live in `src/contracts/domain/`
(Pane, Workspace, Agent) — **this is your data model; design to it.**

---

## 3 · The current UI (what you're reworking — the real code map)

`src/ui/` is **vanilla TypeScript + imperative DOM — there is NO UI framework** (no
React/Vue/Svelte/Lit). The only rendering engine is **xterm.js** (WebGL addon) for
panes. This is *why* the app hits its perf budget (§4). Study:

- `src/ui/styles/global.css` — **the single stylesheet** (~665 lines, ~30 BEM-ish class
  selectors) driven by CSS custom properties. Today the token set is just **7 vars**:
  `--bg #0a0a0a`, `--panel #121212`, `--border rgba(255,255,255,.08)`, `--text #e6e6e6`,
  `--muted rgba(255,255,255,.45)`, `--accent #4ade80` *(green!)*, `--warn #fbbf24`.
  This file is where your token system + base styles go.
- `src/ui/features/workspace/themes.ts` — 4 themes
  (`midnight`/`nord`/`solarized`/`amber`), each `{ chrome: Record<cssVar,value>,
  terminal: xterm ITheme }`; `applyTheme` sets vars on `:root`. Rework this.
- `src/ui/features/workspace/model.ts` — the round-robin **per-workspace accent
  palette** and the UI `WorkspaceMeta` (color, cwd, ordinal, paneCount, assignments);
  `controller.ts` computes tab attention rings + persistence (`saveState`, restore).
- `src/ui/core/` — **ports** (pub/sub singletons, no DOM) that decouple features:
  `slots`, `focus`, `pane-meta`, `pane-cwd`, `attention/attention-port`,
  `theme/theme-port`, `git/git-port`, `agents/launch-port`, `workspace/open-service`,
  `ipc/bridge`. Features talk *only* through these — respect that seam.
- `src/ui/shell/` — `app-shell.ts` (`#app > #titlebar + #content`) + `titlebar.ts`.
- `src/ui/features/` slices: `workspace` (tabs bar + layout toolbar + theme picker +
  orchestration), `layout` (`grid-layout.ts` = CSS-grid with draggable gutters;
  `templates.ts` = 1/2/4/6/8/9/12/16 grid specs), `terminal` (`terminal-pane.ts` =
  xterm + Fit/WebGL/Serialize addons + managed WebGL leasing + `.pane-badge`), `blocks`
  (OSC-133 command blocks), `git` (per-pane `.pane-git` chip), `agents` (launcher button
  + menu), `templates` (provider-mix modal), `agent-state` (titlebar chip).
- `src/renderer/` — thin bootstrap: `index.html` (`<div id="root">`) → `main.ts` →
  `@ui start()` (imports `global.css`, builds the shell, registers + mounts features).

**Current live DOM (so you know the surface):**
```
#app > #titlebar + #content
#content > #workspace-bar(horizontal tabs + layout toolbar + theme <select>) + #workspace-host
#workspace-host > .workspace-view[.active] > .layout-grid > .layout-slot[.focused]
.layout-slot > (xterm) + .block-cover-layer + .pane-badge(.pane-label,.pane-git,.pane-state)
```
Pane ids are deterministic (`ordinal*100 + slot`), slots are reused across template
changes so a PTY isn't killed on resize, workspace switch = pure show/hide (panes stay
mounted + streaming).

**Rendering-approach guidance:** **default to staying vanilla** — expand `global.css`
into a real token system and factor the imperative `createElement` code into small
reusable component *factory functions* (`Button()`, `Stepper()`, `LayoutGridPicker()`,
`WorkspaceRailItem()`, …). Do **not** reach for a heavy framework. A minimal
dependency-light view layer is permissible *only* at the `src/ui` boundary, never in the
hot terminal path, never at the cost of the perf budget, and only with explicit
justification in the design brief. When unsure, stay vanilla.

---

## 4 · The performance budget (a hard gate — read `docs/05-perf-budget.md`)

Rendering reliability under many agents is the product's core wedge. The 16-agent
milestone is **asserted by an automated smoke** (`MOGGING_MILESTONE`), not eyeballed:

- **16 live panes** must hold **avg fps ≥ 30**, **worst frame gap ≤ 150 ms** (stress
  *and* idle), **renderer JS heap ≤ 300 MB**, **≥ 12/16 visible panes on WebGL**.
- Baseline today: ~135 fps, 28 MB heap, 16/16 WebGL — so there's headroom, but a real
  regression (a sync stall, a leak, polling) blows a gate.
- **How it's held:** managed WebGL leasing (IntersectionObserver acquires GL when a pane
  is visible, releases on hidden workspace, self-heals on context loss); cursor-blink
  only on the focused pane; scrollback capped at 10k; attention is **event-driven, not
  polled**; PTYs live off the UI thread in the detached daemon.

**Rule:** any decoration/chip/animation you add must keep this smoke green. If a UI
feature can't meet the budget, **throttle or virtualize it before shipping.**

---

## 5 · The inspiration set — study it, then transcend it

**Critical framing:** the screenshots in `assets/Inspiration/` are **BridgeMind /
BridgeSpace — the exact competitor we exist to beat.** Treat them as a captured
reference of what the category considers good, so you can (a) match their proven
patterns/IA, (b) **exceed them on every axis**, and (c) **rebrand 100% to us**.

- **Open and actually look at every PNG** (Read each image). Use each **filename as the
  guide** to what the screen/state is.
- Extract *interaction patterns and layout logic*, **not** visuals.
- **Strip all competitor identity:** no "Bridge*" names (BridgeSpace, BridgeSwarm,
  BridgeBoard, BridgeMemory, BridgeVoice, BridgeMind), no their logo, no their
  blue/multicolor palette. Clean-room reimplementation — **zero** of their assets/copy.
- **Be honest about scope:** the launcher shot advertises 4 sibling products; we are
  *one focused organizer*. Don't invent fake product tiles.

### Target screens (mapped image → improved, and wired to real functionality)

**Restyle vs net-new first:**
- **Live grid** — *exists*: restyle `terminal-pane.ts`, `grid-layout.ts`, `.pane-badge`;
  reuse WebGL leasing + blocks + git + state.
- **Workspace rail** — *partial*: today a **horizontal** `#workspace-bar` with attention
  *rings* only → convert to a **left vertical rail** + add the **numeric per-workspace
  attention count** (the signature Phase-2 visual).
- **Launcher/Home** — *net-new*: today the app opens straight into the bar (no home).
- **New-Workspace Wizard** — *net-new as a flow*: today the pieces are scattered
  (`#template-dialog` provider-mix modal + layout-toolbar buttons + `workspace:openCwd`)
  → consolidate into one 3-step Start·Layout·Agents wizard on the same
  `templates:resolve` + `workspace` contracts.

**A. `Launcher Screen.png` → Home / Launcher (empty + populated).** Left = the
persistent workspace rail (F). Right = a branded hero (our logo/wordmark + a real
tagline from `docs/00`, e.g. *"Your keys, your CLIs — no subscription to us"*), a primary
**New Workspace** action, **Recent workspaces** (one-click reopen from the persistence
contract), and **Presets**; a bottom keyboard-hint bar. Design a great first-run empty
state *and* a returning-user state. Wire: New Workspace → wizard; recents/presets restore
layout + cwd.

**B+C. `Configure Workspaces.png` + `workspace-configuration-of-working-directory.png` →
New-Workspace Wizard (Start · Layout · Agents).** A clean 3-step stepper. **Working
folder** picker (native browse via bridge + typeahead of recents + validation: exists?
git repo? show branch). **"How many terminals?"** layout picker showing a *true live
preview* of the resulting grid (support split ratios, not just counts 1/2/4/6/8/10/12).
Recent folders + named, editable Presets. Keyboard-drivable; step state persists on Back.

**D. `Terminals-Configuration-after-Workspace-Configuration .png` → Wizard Step 3: assign
agents.** Roster driven by the **real CLI descriptors** (Claude Code, Codex, Gemini,
Aider, OpenCode, + custom command). A fill meter (e.g. "4/8 · 4 empty"), quick-fill
(Enable all / One of each / Split evenly / Clear — obviously reversible), per-agent count
steppers, a mini grid preview of which tile gets which agent, and both "skip — no agents"
and "Launch N terminals" as first-class. **Respect BYO-auth:** never ask for or store
credentials; a needed login is a neutral hint, nothing more. Wire: Launch spawns one PTY
per pane via the bridge (shell + optional agent command + cwd) → transitions to the grid.

**E. `terminals-visually-...-outline-highlight.png` (+ `...-2-...-sidebar-visual-2.png`)
→ Live multi-pane grid (the heart).** Each pane = a crisp header (editable name, cwd/branch
chip, agent-state chip, actions: split/zoom/close), the xterm surface, a compact footer.
**The selected pane gets a beautiful orange focus ring** (§6) — precise, GPU-cheap,
unmistakable. **Reuse** the OSC attention rings/badges, OSC-133 command blocks, per-pane
git chip, and `mogging notify` (already built — restyle, don't rebuild). Grid supports the
templates, **drag-to-resize** splits, focus-follows-click + keyboard pane nav,
maximize/zoom, graceful reflow — all within the perf budget. Wire: each pane is a live
xterm bound to a real PTY over IPC; header actions mutate the layout tree via the
contract; git/attention/blocks flow from the existing ports.

**F. `workspaces-visuals-...-number-of-panes-that-need-attention.png` → The Workspace Rail
(our "who needs me" wedge).** Per-workspace: a distinct accent color (curated set — see
§6), name, live **pane-count** + live **attention count** (how many panes are waiting on
the user), current-workspace **orange outline**, keyboard-selectable, reorderable,
closable. Attention is **event-driven** (existing attention port), never polled; the badge
animates in/out and clears on focus. Across 10+ workspaces the user finds the one that
needs them in <1s. Wire: rail reads workspaces + live per-pane attention from the ports;
click switches workspace (with WebGL re-acquire per the managed strategy).

**Plus (no screenshot, but complete the UX):** a **Settings** surface (themes, default
shell/agent, telemetry consent per `prompts/observability/`), a **Command palette**
(⌘/Ctrl-K) for every action, and polished **toasts** for `mogging notify` events.

---

## 6 · Brand & design system (the logo's palette is the core)

**Color — sampled from `assets/logo.png`** (an "MW" monogram in vivid amber-orange). The
brand color is **`#FD8D03`**. Today the app's accent is *green* (`#4ade80`) — **flip the
identity to orange** and expand the 7 current vars into a full system. The attention
ring/glow currently uses green (`box-shadow: 0 0 0 1px var(--accent), 0 0 8px
rgba(74,222,128,.45)`) — rebrand to an orange glow. Rework `themes.ts` + the workspace
accent palette in `model.ts` to harmonize.

Suggested tokens (tune all for AA; don't just accept them):
```
/* Brand orange ramp (from the logo) */
--brand-50:#FFF4E5; --brand-100:#FFE3BF; --brand-200:#FFC97F; --brand-300:#FFB24D;
--brand-400:#FE9C1F; --brand-500:#FD8D03; /* logo core */ --brand-600:#E07A00;
--brand-700:#B86200; --brand-800:#8A4900; --brand-900:#5C3100;
/* Neutrals — dark-first terminal surfaces */
--bg-app:#0C0D0F; --bg-surface:#141518; --bg-elevated:#1B1D21; --bg-inset:#0A0B0D;
--border:#26282D; --border-strong:#33363C;
--text-hi:#F4F5F7; --text-mid:#A9AEB6; --text-lo:#6B7079;
/* Semantic */
--success:#35C46A; /* exit 0 */ --danger:#F0554B; /* non-zero exit */
--warning:#F5A623; --info:#4DA3FF; --attention:var(--brand-500);
```
- **Orange is the accent, not the wallpaper** — primary CTA, selected-pane ring, active
  nav, focus states, attention glow, deployed sparingly on deep neutrals so it *pops*.
  Don't tint whole panels orange.
- **Per-workspace accents:** curate ~8 that harmonize with the brand and hold AA on dark
  (orange, teal, violet, rose, lime, sky, amber, magenta). The *current* workspace always
  reads via the **brand-orange outline** regardless of its icon accent.
- Provide the same tokens for a **light theme**; support `prefers-color-scheme` + an
  explicit override. **Derive the xterm theme from the same tokens** so panes match chrome.

**Type / spacing / shape / motion.** UI font: a clean variable sans (Inter or the system
UI stack) with a real scale (11/12/13/14/16/20/28). Mono: match the existing xterm config
(`"Cascadia Code","Cascadia Mono",Menlo,Consolas,monospace` @ 13). Spacing 4-based
(4/8/12/16/24/32); radii small set (6/10/14); defined elevation shadows. Motion fast +
purposeful (120–200ms), always respecting `prefers-reduced-motion`.

**Quality bar — how to "go beyond":** aim above Warp/BridgeSpace.
- **Glanceability:** across 12 workspaces × 16 panes, "who needs me" is found in <1s;
  attention states are loudest, idle is quiet.
- **Keyboard-first:** everything reachable without a mouse (pane nav, splits, workspace
  switch, ⌘/Ctrl-K palette, wizard, close/zoom); show accelerators.
- **Designed empty/loading/error states** for every surface.
- **Micro-interactions:** hover/pressed/focus states, drag handles, smooth grid reflow,
  optimistic UI.
- **Accessibility:** WCAG 2.1 AA contrast; full keyboard nav; visible focus; ARIA
  roles/labels; `prefers-reduced-motion`; never rely on color alone (pair attention with
  a count/icon).
- **Consistency:** one spacing/type/color system; no one-off values.
- **Cross-platform native feel:** identical on Win + Mac, correct per-OS accelerators
  (⌘ vs Ctrl) and window controls.

---

## 7 · The gates (must stay green)

- The **perf budget** (§4) — `MOGGING_MILESTONE` green.
- **Boundaries** (§2) — `@ui` imports only `@contracts`; UI Electron/Node-free.
- **Never broker provider auth** (ADR 0002) — no credentials in UI/state/telemetry/notify.
- **No competitor identity** — no "Bridge*" names/logo/palette anywhere.
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean; env-gated smokes
  green (`MOGGING_SMOKE`, `MOGGING_MULTIPANE`, `MOGGING_ATTENTION`, `MOGGING_BLOCKS`,
  `MOGGING_GIT`, `MOGGING_NOTIFY`, `MOGGING_MILESTONE`). If a smoke asserts on a class
  name/DOM hook you change, update the smoke intentionally.

**Definition of done:** a fully redesigned, cohesive, accessible, orange-branded
MoggingLabs Workspace where the launcher, new-workspace wizard, live multi-pane grid, and
workspace-attention rail all look better than the inspiration, are wired to real
functionality, hold the 16-agent perf budget, respect every architecture/auth boundary,
and carry zero trace of competitor branding.
