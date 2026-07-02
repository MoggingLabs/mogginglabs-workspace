# GOAL — Full UI/UX redo of MoggingLabs Workspace

You are lead designer **and** front-end engineer for MoggingLabs Workspace. Do a
**complete redo of the app's UI/UX** — every screen, component, interaction — and **wire
each surface to the real contracts/IPC** so it works. Bar: the best terminal-organizer UI
in its category, identical on Windows and macOS.

## First: get full context
**Read `prompts/ui-redo/CONTEXT.md` and `prompts/ui-redo/DESIGN-BRIEF.md` in full, then the files it links** (README; docs
00/01/02/03/05 + ADRs; `src/contracts/`; `src/ui/` — `styles/global.css`,
`features/workspace/{themes,model,controller}.ts`, `core/` ports, `shell/`, feature
slices; `src/renderer/`). Then **open every PNG in `assets/Inspiration/`** (Read each; the
filenames say what each screen is). Post a ≤1-page "what I understand" summary.
**Gate: no UI code until that's solid.**

Honor (details in CONTEXT):
- Vanilla **TS + DOM, no framework**; xterm.js for panes. **Default: stay vanilla** —
  expand `global.css` into a token system + factor reusable component factory functions.
- The inspiration is the **competitor (BridgeSpace)** — mine its patterns, exceed it,
  **rebrand 100%**: no "Bridge*" names/logo/palette anywhere.
- Brand color from the logo = **`#FD8D03` orange** (today's accent is green `#4ade80` —
  flip it). Orange is the accent, not the wallpaper.

## Build order
1. **Design brief** — token system + component inventory + screens mapped to each image
   (and how each goes *beyond* it) + which files/features you reuse vs rebuild. Present,
   then proceed.
2. **Tokens + global styles** — token layer in `global.css`; derive the xterm theme from
   it; rework `themes.ts` + workspace accents in `model.ts`; verify light/dark + AA.
3. **Component library** — buttons, inputs, path picker, layout-grid picker, steppers,
   badges/pills, pane frame, workspace-rail item, modal/wizard shell, toasts, palette.
4. **Screens** (CONTEXT §5), building **and wiring each to contracts/IPC** as you go — a
   screen isn't done until it works:
   - **Launcher/Home** (net-new) · **New-Workspace Wizard** Start·Layout·Agents (net-new
     flow; folder picker + live layout preview + real CLI roster + BYO-auth) · **Live grid**
     (restyle; orange selected-pane ring; drag-resize; keyboard nav) · **Workspace rail**
     (net-new left vertical rail with **numeric per-workspace attention counts**).
5. **Integrate existing features** — attention rings/badges, OSC-133 command blocks, git
   chip, `mogging notify` toasts — restyled, behavior preserved.
6. **Verify + QA** (gates below), then **report** screen-by-screen with before/after notes.

## Hard gates (must stay green)
- **Perf budget** (`docs/05-perf-budget.md`, `MOGGING_MILESTONE`): 16 panes ≥30 fps, worst
  frame gap ≤150ms, heap ≤300MB, ≥12/16 on WebGL. Honor managed WebGL leasing; attention
  event-driven, never polled. If a feature can't meet it, throttle/virtualize.
- **Boundaries:** `@ui` imports only `@contracts` — no `@backend`/`electron`/`node-pty`/
  Node built-ins. Extend data shapes only via `@contracts`; privileged calls via
  `window.bridge`.
- **Never broker provider auth** (ADR 0002) — no credentials in UI/state/telemetry/notify.
- **No competitor identity** — no "Bridge*" names/logo/palette.
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean; smokes green
  (`MOGGING_SMOKE`, `MULTIPANE`, `ATTENTION`, `BLOCKS`, `GIT`, `NOTIFY`, `MILESTONE`). If a
  smoke asserts on a class/DOM hook you change, update it intentionally.

Work incrementally; keep the app runnable throughout. When a load-bearing choice is
ambiguous, make the strongest product call and note it — don't stall.

**Done =** a cohesive, accessible, orange-branded app whose launcher, wizard, live grid,
and attention rail all beat the inspiration, are wired to real functionality, hold the
16-agent perf budget, respect every boundary, and carry zero competitor branding.
