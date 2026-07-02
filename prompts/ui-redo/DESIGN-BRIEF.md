# DESIGN BRIEF — MoggingLabs Workspace UI/UX Redo

Working spec for the redo. Grounded in `CONTEXT.md`, `GOAL.md`, the real code
(`src/ui/`, `src/contracts/`), the perf budget, and the smoke gates. This is the
"present, then proceed" deliverable (GOAL build-order step 1).

---

## 0 · What I understand (the ≤1-page summary)

**Product.** Electron desktop app that runs many parallel AI coding-agent CLIs (Claude
Code, Codex, Gemini, Aider, OpenCode + custom) as real PTYs in a fast multi-pane
xterm.js/WebGL terminal with persistent workspaces. BYO-auth: it launches the user's own
CLIs under their own login and **never brokers provider auth**. Phase-2 wedge = **agent
awareness**: *"16 agents, see who needs you at a glance, nothing freezes."*

**Codebase reality.** Vanilla **TS + imperative DOM, no framework**; xterm.js is the only
render engine. One stylesheet (`global.css`, ~665 lines) driven by **7 CSS vars**; accent
is currently **green `#4ade80`**. Features are decoupled through `src/ui/core/` **ports**
(pub/sub singletons) and talk only through them + `@contracts`. Boot: `renderer/main.ts →
@ui start() → createAppShell(#root) → registerFeature ×6 → mountFeatures`. Live DOM today:
`#app > #titlebar + #content`; `#content > #workspace-bar(horizontal tabs) + #workspace-host`;
`.workspace-view > .layout-grid > .layout-slot(.focused) > xterm + .pane-badge(.pane-label,
.pane-git, .pane-state)`. Pane ids are deterministic: **`ordinal*100 + slot`**.

**Data model I design to (`@contracts`).** `AgentState = 'idle'|'busy'|'attention'`;
`PaneId = number`; `WorkspaceStateMeta {id,name,color,cwd,ordinal,paneCount,assignments?}`;
`WorkspaceState {workspaces[],activeId,theme}`. IPC via one global `window.bridge =
{invoke,send,on}`, allowlisted against `AllChannels`. Real CLI roster (backend) surfaces to
UI as `AgentInfo {id,name,installed}` over `agents:detect`; templates via
`ProviderCount[] → templates:resolve → ResolvedLayout {paneCount,assignments}`.

**Hard gates.** Perf: 16 panes ≥30fps, worst frame gap ≤150ms, heap ≤300MB, ≥12/16 WebGL
(`MOGGING_MILESTONE`; baseline has 3–10× headroom). Boundaries: `@ui` imports only
`@contracts`. Never broker auth. Zero competitor ("Bridge*") identity. `typecheck`→0,
`build`→ok, smokes green. **Load-bearing DOM hooks the smokes assert on** (must preserve or
update the smoke intentionally): `.workspace-tab` + `data-attention`; `.pane-state[data-state]`;
`.pane-git.has-git.dirty`; `.layout-slot[data-pane-id]`; `.pane-badge/.pane-label`;
`#root`, `#titlebar`, `.pane`, `canvas`.

**Inspiration = the competitor (BridgeSpace).** Mined IA/interaction from all 7 shots;
rebrand 100% — no Bridge* names/logo, no blue/multicolor palette. Flip identity to the
logo's **orange `#FD8D03`**, used as an *accent* on deep neutrals, never as wallpaper.

---

## 1 · Token system (global.css layer; reworks themes.ts + model.ts)

**Brand orange ramp** (from `assets/logo.png`):
`--brand-50 #FFF4E5 · 100 #FFE3BF · 200 #FFC97F · 300 #FFB24D · 400 #FE9C1F ·
500 #FD8D03 (logo core) · 600 #E07A00 · 700 #B86200 · 800 #8A4900 · 900 #5C3100`

**Neutrals (dark-first):** `--bg-app #0C0D0F · --bg-surface #141518 · --bg-elevated #1B1D21
· --bg-inset #0A0B0D · --border #26282D · --border-strong #33363C · --text-hi #F4F5F7 ·
--text-mid #A9AEB6 · --text-lo #6B7079`. (All tuned/verified for WCAG AA on their surface.)

**Semantic:** `--success #35C46A` (exit 0) · `--danger #F0554B` (non-zero exit) ·
`--warning #F5A623` · `--info #4DA3FF` · `--attention var(--brand-500)`.

**Per-workspace accents (8, AA on dark, harmonize with brand):** orange(brand), teal,
violet, rose, lime, sky, amber, magenta. Rule: a workspace's icon uses its own accent, but
the **current** workspace always reads via the **brand-orange outline** regardless.

**Type.** UI: Inter / system UI stack, scale 11/12/13/14/16/20/28, weights 400/500/600.
Mono: existing xterm stack `"Cascadia Code","Cascadia Mono",Menlo,Consolas,monospace` @13.
**Spacing** 4-based: `--space-1..6 = 4/8/12/16/24/32`. **Radii** `--radius-sm/md/lg = 6/10/14`.
**Elevation** `--shadow-1/2/3`. **Motion** `--dur-fast 120ms / --dur-med 200ms`, standard
ease; everything wrapped by `@media (prefers-reduced-motion: reduce)`.

**Migration strategy (keeps app runnable & green):** add the full token layer to
`:root` in `global.css`, then **redefine the 7 legacy vars in terms of new tokens**
(`--accent: var(--brand-500)`, `--bg: var(--bg-app)`, `--panel: var(--bg-surface)`,
`--warn: var(--warning)`, …) so every existing selector keeps working while I migrate them.
Rework `themes.ts` so each theme writes the **full** token set (not just 7) and the xterm
`ITheme` is **derived from the same tokens**; add a **Light** theme; honor
`prefers-color-scheme` + explicit override. Rework `WORKSPACE_COLORS` in `model.ts` to the
curated 8-accent set.

---

## 2 · Component library (`src/ui/components/`, vanilla factory functions)

Each returns an `HTMLElement` (+ small controller where stateful). No framework.

`Button` (primary/secondary/ghost/danger, sizes, icon, optional `kbd` hint) · `IconButton`
(aria-labelled) · `TextInput` · `PathInput` (folder icon + browse + typeahead + validation
chip) · `Stepper` (− n +) · `Checkbox`/`Toggle` · `Pill`/`Badge` (tones: label, git,
attention-count, pane-count) · `Meter` (the "4/8 · N empty" agent fill bar) ·
`MiniGridPreview` (rows×cols, optional per-tile assignment) · `LayoutGridPicker` (count
tiles built from `MiniGridPreview`) · `WizardStepper` (Start·Layout·Agents, checks +
connectors) · `WorkspaceRailItem` (accent icon, name, attention pill, pane-count pill,
active outline, close) · `PaneHeader`/`PaneFrame` (name, cwd/branch chip, state chip,
actions) · `Modal`/`WizardShell` · `ToastHost`/`Toast` · `CommandPalette` (⌘/Ctrl-K) ·
`RecentList` · `PresetGrid` · `EmptyState` · `Segmented` (settings).

---

## 3 · Screens (image → what we ship → how it goes beyond) + wiring

**Shell change:** app boots into a persistent **left vertical rail + right content region**;
right content is **Home** when no workspace is active, or the **grid** when one is. (Matches
the inspiration's always-present rail; a tiny view-router in `shell/` swaps the right side.)

| # | Image | We ship | Beyond the competitor | Wired to |
|---|---|---|---|---|
| **A** | `Launcher Screen` | **Home/Launcher**: MW logo/wordmark hero + tagline *"Your keys, your CLIs — no subscription to us."*, primary **New Workspace**, **Recent workspaces**, **Presets**, bottom keyboard-hint bar. First-run empty state + returning state. | **No fake sibling products** (we're one focused organizer, not 4 tiles). Real one-click recents restore; honest scope. | `workspace:loadState` (recents), `templates:list` (presets), New→wizard |
| **B/C** | `Configure Workspaces`, `workspace-configuration-of-working-directory` | **Wizard Start·Layout**: working-folder picker (browse + recents typeahead + git/branch chip), layout picker with **true live grid preview**, recents + editable presets. | Live preview + soft git/branch validation; fully keyboard-drivable; **step state persists on Back**. | `workspace:browseDir`* (native dialog), `git:query` (branch chip), `templates:list` |
| **D** | `Terminals-Configuration...` | **Wizard Agents**: roster from real `agents:detect`, **fill meter** (4/8 · N empty), quick-fill (Enable all / One of each / Split evenly / Clear), per-agent steppers, **mini grid preview of assignment**, custom command, **Skip — no agents** vs **Launch N**. | Assignment preview; obviously-reversible quick-fill; **BYO-auth respected** — never ask/store creds; a needed login is a neutral hint. | `agents:detect` → build `ProviderCount[]` → `templates:resolve` → `openWorkspaceFromTemplate` → PTY spawn + agent launch |
| **E** | `terminals-...-outline-highlight` (+ `...-2`) | **Live grid** (restyle): pane header (editable name, cwd/branch chip, agent-state chip, actions split/zoom/close), xterm body, compact footer; **orange selected-pane ring**; drag-resize splits; focus-follows-click + keyboard pane nav; maximize/zoom. | Precise GPU-cheap orange ring; keyboard-first pane nav + zoom; graceful reflow — all inside the perf budget. | Reuse `terminal-pane.ts` (xterm+WebGL leasing), `grid-layout.ts`, blocks (OSC-133), git chip, attention port |
| **F** | `workspaces-visuals-...-number-of-panes-that-need-attention` | **Workspace rail** (net-new left vertical): per-ws accent icon + name + **numeric attention count** (orange pill) + pane-count pill; **current = brand-orange outline**; keyboard-select, reorder, close. | The signature Phase-2 visual — **find who needs you in <1s** across 10+ workspaces; attention loudest, idle quiet; **event-driven, never polled**; pairs color with a number (not color-alone). | Reuse attention port + `controller.refreshAttention` (extend to emit **counts**); `workspace:attention` (dock badge) |

| **G** | `Application-header-top-bar` | **Slim titlebar**: left cluster = rail-collapse toggle + search/palette trigger; brand center-left; right = agent-state chip + actions. | Palette trigger doubles as global search (⌘/Ctrl-K); we keep the native OS window frame (identical Win/Mac behavior) instead of their frameless chrome — flagged as a deliberate deviation. | Rail-collapse state, palette open |

**Plus (complete the UX):** **Settings** (themes, default shell/agent, telemetry consent
per `prompts/observability/`), **Command palette** (⌘/Ctrl-K for every action), **Toasts**
for `mogging notify` events (restyled, throttled).

\* `workspace:browseDir` is a small, in-bounds **contract extension** — see §5.

---

## 4 · Reuse vs rebuild

**Reuse (restyle only, behavior preserved):** `terminal-pane.ts` (xterm + Fit/WebGL/Serialize
addons + **managed WebGL leasing** — restyle `.pane-badge` into a proper pane header); ALL
`core/` ports (the seam — untouched); `grid-layout.ts` (CSS grid + gutters — add keyboard
nav + zoom); `blocks/` (OSC-133 gutters/collapsed — restyle); `git/` chip; `agent-state`
chip; controller **persistence** (save/restore).

**Rework:** `themes.ts` (full token set + xterm derivation + Light), `model.ts`
(`WORKSPACE_COLORS` → curated 8), `workspace/index.ts` bar → **vertical rail**, `global.css`
(token system + all selectors).

**Net-new:** `components/` factory library; **Home** feature slice; **Wizard** feature slice
(consolidates the scattered `templates` modal + layout toolbar + `openCwd`); **Settings**;
**Command palette**; **Toasts**; tiny **view-router** in `shell/`.

---

## 5 · Load-bearing product decisions (my calls — flag, don't stall)

1. **"Current = orange" vs "attention = orange" tension.** Kept distinct by *shape*, not
   just color: current workspace = solid brand-orange **outline/left-bar** on the rail item;
   attention = **filled orange pill with a number** + soft glow + gentle pulse
   (reduced-motion aware). Never color-alone (always paired with the count/icon). AA-checked.
2. **Boot flow.** App boots to **Home** with the persistent rail. Selecting/creating a
   workspace shows the grid; closing the last/active returns to Home. Restore rehydrates
   workspaces into the rail (unchanged persistence) and lands on Home's returning-state.
3. **Native folder browse → one contract extension.** No dialog channel exists. Add
   `workspace:browseDir` (invoke → `string | null`) backed by Electron `dialog.showOpenDialog`
   in **main** (composition root); UI calls it via `window.bridge`. Reuse **`git:query`** for
   the branch/git chip (soft, non-blocking — non-git folders are fine). This is the only new
   channel; added the ADR-0004 way (channel in `@contracts` + handler in the composition root).
4. **Custom-command agent.** `Provider` is `string` and `"shell"` is the reserved no-op.
   Wizard's custom command = spawn a shell pane and `terminal:write` the command (same path
   as `agents launchInto`), stored as an `assignment` label only (never a credential).
5. **Preserve smoke hooks.** Keep `.workspace-tab` + `data-attention` **on the new rail item
   root**, and `.pane-state[data-state]`, `.pane-git.has-git.dirty`, `.layout-slot[data-pane-id]`,
   `.pane-badge/.pane-label` intact. Where the vertical-rail restructure genuinely forces a
   selector change, update `attention-smoke.ts` / `milestone-smoke.ts` **intentionally** and
   note it.
6. **Stay vanilla.** Component factories + a ~30-line view-router only. Nothing in the hot
   terminal path; WebGL leasing untouched; rail attention counts are event-driven (no polling);
   toasts throttled; palette lazy-built. Perf budget stays green.

---

## 6 · Execution plan (GOAL build order)

1. ✅ Design brief (this doc). 2. Tokens + global styles (+ themes.ts / model.ts; verify
light/dark + AA). 3. Component library. 4. Screens A–F, each **wired to contracts/IPC**
(+ the `workspace:browseDir` extension). 5. Integrate existing features (attention, blocks,
git, notify toasts) restyled. 6. Verify + QA (typecheck, build, all `MOGGING_*` smokes,
boundary grep, no-Bridge grep) → report screen-by-screen with before/after. Keep the app
runnable and the milestone smoke green throughout.
