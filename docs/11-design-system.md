# 11 — Design system (Phase-5/01: audit + color system)

The single source of truth for the token layer. Established by the Phase-5/01 audit:
every surface screenshotted in both themes (`MOGGING_SHOT=all` → `out/gallery/`,
46 shots), every color claim below **measured** (WCAG 2.x relative-luminance contrast;
the math lives in the audit script and is reproduced by any WCAG contrast checker).
AA thresholds used: **4.5:1** for text/icon-grade ink, **3:1** for non-text UI.

Rules (enforced by grep, see § Guardrails):

- Colors are defined in exactly TWO places: the token layer (`global.css` § 1 + the
  `@media` first-paint fallback in § 2) and the theme files (`src/ui/core/theme/
  themes.ts`). Feature CSS consumes tokens only.
- The one sanctioned inline style: the rail controller stamps `--ws-accent` on each
  `.workspace-tab` (`controller.ts`). Everything else derives via `color-mix`.
- Legacy aliases (`--bg --panel --text --muted --warn`) remain mapped onto tokens
  until the last pre-redo selector migrates.

## Token catalog

### Surfaces & borders (neutrals — per-theme)

Layers must READ as layers: `inset < app < surface < elevated` (dark) and the inverse
stack on light. Re-tuned in 01 — the old dark surface/elevated steps were 1.07×/1.15×
(muddy, board lanes vanished into the canvas); light had surface = elevated = `#ffffff`
(elevation collapsed entirely: cards, lanes and menus shared one white).

| Token | Purpose | Midnight | Light |
|---|---|---|---|
| `--bg-inset` | recessed wells: inputs, terminal seams, kbd | `#060709` | `#e7eaef` |
| `--bg-app` | app canvas + terminal background | `#0c0d0f` | `#f2f4f7` |
| `--bg-surface` | chrome: titlebar, rail, pane headers, lanes | `#15171c` | `#fbfcfe` |
| `--bg-elevated` | pop layer: menus, modals, cards, buttons | `#1f2228` | `#ffffff` |
| `--border` | hairlines between layers | `#2a2d34` | `#d9dde4` |
| `--border-strong` | emphasized hairlines, idle state dot | `#3b3f48` | `#b7bec9` |

Measured layer steps (luminance ratios): dark `inset→app` 1.04, `app→surface` 1.08,
`surface→elevated` 1.13; border-on-app 1.41:1 (was 1.32). Light `elevated→surface`
1.03, `surface→app` 1.07, `app→inset` 1.09; border-strong-on-white 1.87:1.

Nord and Solarized keep their palettes; only `--text-lo` was bumped for AA (below).

### Text (per-theme) — measured on every surface it sits on

| Token | Midnight | on app / surface / elevated | Light | on app / white / inset |
|---|---|---|---|---|
| `--text-hi` | `#f4f5f7` | 17.8 / 16.4 / 14.6 | `#15171b` | 16.3 / 17.9 / 14.9 |
| `--text-mid` | `#a9aeb6` | 8.7 / 8.0 / 7.2 | `#4b515b` | 7.3 / 8.0 / 6.6 |
| `--text-lo` | `#868d97` | 5.8 / 5.4 / **4.8** | `#60656e` | 5.3 / 5.9 / **4.9** |

`--text-lo` was `#7c828b` (dark) / `#666b74` (light): **4.36:1** on dark elevated and
**4.44:1** on the new light inset — both under AA for the captions/hints that sit
there. Nord `--text-lo` `#8b93a5` → `#a6aebf` (3.3 → 4.5 on its elevated); Solarized
`#758a8a` → `#93abab` (3.1 → 4.6).

### Brand & accent

| Token | Value | Notes |
|---|---|---|
| `--brand-50…900` | `#fff4e5 … #5c3100` | ramp sampled from the logo; `--brand-500 #fd8d03` is the core |
| `--accent` | `var(--brand-500)` | fills, rings, dots — constant across themes |
| `--accent-ink` | dark `var(--brand-400)` · light `#9c5300` | orange as text/icon. Dark 9.3:1 on app; light 5.8:1 on white, 4.8:1 on inset (old `#a55800` was 4.36 on inset) |
| `--accent-contrast` | `#201200` **both themes** | text on an accent fill — 7.8:1 on brand. The light theme's old warm near-white (`#fff8ee`) measured **2.3:1** on the primary buttons |
| `--accent-weak` | `rgba(253,141,3,.13)` | hover wash / selected tint |
| `--accent-glow` | `rgba(253,141,3,.4)` | focus + attention halo |
| `--scrim` | `rgba(2,3,5,.55)` | the ONLY overlay film (palette + modal — was two ad-hoc rgba values) |
| `--selection-bg` | `rgba(253,141,3,.28)` | ::selection + xterm selection (themes.ts) |

### Semantic — per-theme, text-grade on both

Dark keeps the vivid set; light overrides them (the dark values measure 1.9–3.4:1 on
white — the review diff, "not found on PATH" pills and settings errors were washed out).

| Token | Midnight | on app / elevated | Light | on white / app / inset |
|---|---|---|---|---|
| `--success` | `#3fc873` | 9.0 / 7.4 | `#147a3c` | 5.4 / 4.9 / 4.5 |
| `--danger` | `#f0554b` | 5.7 / 4.6 | `#c92e25` | 5.4 / 4.9 / 4.5 |
| `--warning` | `#f5a623` | 9.6 / 7.9 | `#8a5c09` | 5.8 / 5.3 / 4.8 |
| `--info` | `#4da3ff` | 7.4 / 6.1 | `#1d63d8` | 5.5 / 5.0 / 4.6 |
| `--attention` | `var(--brand-500)` | — | (same) | attention is always brand-orange |
| `--danger-weak` | `rgba(240,85,75,.14)` | hover wash | (same) | |

`.pane-remote` now consumes `--info` (was hard-coded `#58a6ff`: 2.5:1 on white).

## Workspace identity — the ramp

`WORKSPACE_COLORS` (`src/ui/features/workspace/model.ts`) assigns one vivid identity
color per workspace ordinal. The rail controller stamps it inline as `--ws-accent` on
the `.workspace-tab` (the ONE sanctioned inline style); `global.css` derives the ramp
per theme via `color-mix` — consumers use ONLY the ramp stops:

| Stop | Derivation (dark) | Derivation (light) | Use |
|---|---|---|---|
| `--ws-accent` | the raw identity color | (same — washes/fills only) | vivid stop |
| `--ws-ink` | `= accent` | `color-mix(in srgb, accent 54%, black)` | text/icon-grade |
| `--ws-tint` | `color-mix(accent 12%, transparent)` | (same) | surface wash |
| `--ws-tint-hover` | `color-mix(accent 6%, transparent)` | (same) | hover whisper |
| `--ws-edge` | `= accent` | `= ink` | border-weight stop |
| `--ws-glow` | `color-mix(accent 42%, transparent)` | (same) | soft outer halo |

### Rail selection spec (Phase-5/02)

The selected workspace lights up in ITS color; selection is the only loud thing in
the rail. States, quiet → loud (all ramp stops — no per-feature color):

| State | Treatment |
|---|---|
| rest | neutral `--text-mid` label, identity only on the icon glyph (`--ws-ink` on a `--bg-inset` chip) |
| hover | `--ws-tint-hover` wash (6% identity whisper) |
| press | full `--ws-tint` |
| **selected** | `--ws-tint` across the button + 1px `--ws-edge` outline + **3px inset left bar** (`box-shadow: inset 3px 0 0` — zero layout shift, geometry-probed) + label/icon in `--ws-ink` (paint-only: no weight flip — switch is on the perception hot path) |
| focus-visible | the global 2px brand focus ring (interaction ≠ selection) |
| drag | 0.55 ghost opacity |

**Attention stays brand orange** — it means "needs you", never "which one is active".
The latched ring is a soft outer glow (`0 0 0 1px --accent-glow, 0 0 14px --accent-glow`
— no hard border), so a ringing neighbor composes with a vivid selected tab. The
active workspace never rings (Phase-2 semantics, smoke-asserted) but its live
`.ws-attn` badge still shows; a combined rule keeps bar-inside/glow-outside readable
if both states ever co-occur. Label overflow fades via an alpha `mask-image` instead
of "…". Contrast: selected label ink on its own tint wash ≥4.8:1 light / ≥5.5:1 dark
for all 8 identities (measured in the table above). The `no-layout-shift` guarantee
is asserted by `out/gallery/probe-rail.json` (tab width + icon x equal, selected vs
not, within 0.5px).

### The 8 identity colors — measured

Recalibrated in 01: **amber `#fbbf24` → green `#4ade80`** (amber sat 12° from brand
orange — with 7+ workspaces open the two were indistinguishable at rail-icon size)
and **lime `#a3e635` → `#9bdf2f`** (so its light ink stop clears 4.5 on the tint
wash). Adjacent ordinals now differ by ≥49° of hue.

| # | Name | `--ws-accent` | accent on dark app | accent on dark tint-wash | light `--ws-ink` | ink on white | ink on light tint-wash |
|---|---|---|---|---|---|---|---|
| 1 | teal | `#2dd4bf` | 10.4 | 7.7 | `#187267` | 5.8 | 5.2 |
| 2 | violet | `#a78bfa` | 7.1 | 5.5 | `#5a4b87` | 7.5 | 6.6 |
| 3 | sky | `#38bdf8` | 9.1 | 6.8 | `#1e6686` | 6.4 | 5.7 |
| 4 | rose | `#fb7185` | 7.2 | 5.6 | `#883d48` | 7.5 | 6.5 |
| 5 | lime | `#9bdf2f` | 12.0 | 8.6 | `#547819` | 5.2 | 4.8 |
| 6 | magenta | `#e879f9` | 7.9 | 6.1 | `#7d4186` | 7.1 | 6.2 |
| 7 | green | `#4ade80` | 11.2 | 8.1 | `#287845` | 5.4 | 4.9 |
| 8 | brand | `#fd8d03` | 8.3 | 6.4 | `#894c02` | 6.8 | 6.0 |

Every dark accent ≥7:1 (text-grade with margin); every light ink ≥4.5:1 on white AND
on its own 12% tint wash. Vividness lives in the accent/tint/glow stops; light theme
readability lives in ink/edge — neither sacrifices the other.

## Scales (as they actually are)

- **Type** (`--fs-*`): 11 · 12 · 13 (base) · 14 · 16 · 20 · 24 · 28 px, JetBrains Mono
  Variable everywhere (`--font-ui` = `--font-mono`). Weights 400/500/600/700
  (`--fw-regular/medium/semibold/bold`). Tracking: `--track-tight -0.035em` (headings),
  `--track-wide 0.14em` (uppercase labels). One un-tokenized stragglers set exists at
  9–10px in chips/kbd (logged as UX-21).
- **Space** (`--sp-1…6`): 4 · 8 · 12 · 16 · 24 · 32 px (4-base).
- **Radius**: `--r-sm 6` · `--r-md 10` · `--r-lg 14` · `--r-full 999` px; terminals
  are deliberately square (`border-radius: 0` on `.layout-slot`).
- **Elevation**: `--shadow-1/2/3` (per-theme alpha); dark leans on surface steps,
  light on shadows + borders.
- **Motion**: `--dur-1 120ms` · `--dur-2 200ms`, `--ease cubic-bezier(.2,0,0,1)`;
  reduced-motion collapses all to ~0.
- **Layout**: `--rail-w 288px` · `--rail-w-collapsed 60px` · `--titlebar-h 40px`.

## Window chrome (Phase-5/04)

- **Titlebar** is a strict 3-column grid (`minmax(0,1fr) auto minmax(0,1fr)`), no
  horizontal padding of its own — so the center cell (the command box) sits at TRUE
  window center at any width (probed: trigger center within 1.5px of `innerWidth/2`).
  The native-controls reserve is padding *inside* the right cell:
  `max(--controls-reserve, calc(100vw − env(titlebar-area-x) − env(titlebar-area-width) + sp-2))`.
  The `max()` floor exists because Win11's overlay `env()` **flaps** (measured across
  sessions: sometimes a correct reserve, sometimes 0 with `windowControlsOverlay.
  visible === false` at rest, sometimes a stale fullscreen-width rect) — the floor
  keeps icons clear of the OS buttons no matter which mood env() is in. macOS keeps
  a plain `--sp-3` (controls live top-left, cleared by brand padding).
  Drag audit: the whole strip drags; buttons/inputs/right-cluster opt out.
- **Window state is event-driven** (`shell:windowState`, pushed from main on
  enter/leave-fullscreen + (un)maximize + once per load — never polled). The
  renderer mirrors it as `#app.is-fullscreen` / `#app.is-maximized`. Main tracks
  state from the **event identity**, not a re-query — on Windows,
  `enter-full-screen` fires before `isFullScreen()` flips, so a re-query inside the
  handler reports the OLD state (measured; the class never applied until fixed).
  In fullscreen the reserve collapses to `--sp-3` (the class + a
  `@media (display-mode: fullscreen)` belt both beat stale env()), so the bar ends
  flush right exactly like it starts left — no dead gap.
- **Corner harmony**: `--window-corner: 8px` (the Win11 restored-window radius).
  `#main` rounds its bottom corners and clips (`overflow: hidden`), so the rail's
  bottom-left and the grid's bottom-right borders follow the OS curve instead of
  being clipped square. Maximized/fullscreen windows are square → the classes drop
  the radius. Panes themselves stay hard-cornered (the standing terminal-chrome
  rule); only the frame curves.
- Verified by the gallery state matrix (restored/maximized/fullscreen × both
  themes) + `out/gallery/probe-chrome.json` (fullscreen right gap ≈ sp-3, restored
  gap = controls reserve, no horizontal overflow, trigger centered).

## Terminal type (Phase-5/06)

**Default: 14px / line-height 1.3 (fixed)** — picked from the shot matrix
(`MOGGING_SHOT=typematrix` → `out/gallery/typematrix/`, selection committed under
`docs/assets/gallery/typematrix/`): the same busy specimen (colored agent output,
box glyphs, a diff, a prompt) at 13 / 13.5 / 14 / 15px × lh 1.2 / 1.3 / 1.35, at
4-pane and 16-pane densities.

Rationale, from the shots:
- **13 → 14 is a real legibility jump** at 4-pane: glyph counters open, the
  `O0 1lI|` set separates cleanly, color-coded diff lines scan at arm's length —
  the all-day squint is the 13px default, not the family.
- **15px wraps** typical prompt/path lines at 4-pane half-width — the column
  budget costs more than the legibility gains. Selectable, not the default.
- **14px stays useful at the 16-pane wall** (~10 readable rows per pane; long
  paths wrap identically at 13 and 14 at that width).
- **lh 1.2 is too dense** for day-long scanning (descenders crowd box rows);
  1.35 is indistinguishable from 1.3; box-drawing glyphs stay contiguous at 1.3.

Controls: Settings § Terminal exposes **fontSize only** (segmented 12–16px,
persisted, applied LIVE to every open pane); line-height is fixed by design.
Every size change rides the house remeasure→refit pipeline (option change →
xterm re-measure → `refit(force)` → PTY resize) — there is no second metrics
path. Chrome (28px pane header, fs-10/11 chips, 3px block gutter) is plain CSS
px and NEVER scales with the buffer type; only block-overlay *positions* follow
cell metrics, by design. Standing gates: the reveal probe loops fontSize
12/14/16 and asserts the fill math (screen fills body minus at most one partial
column + scrollbar reserve, header height constant) — `out/shot-probe.json
.sizesPass`; the perception smoke includes a live size-change cycle (atlas
re-warm must not hitch).

## Full-app views (Phase-5/05)

- `AppView = 'home' | 'grid' | 'board' | 'settings'`. Exactly one top-level view
  owns everything below the titlebar; `#app.view-<x>` (and `#content.view-<x>`)
  classes route it. The **rail renders only in the grid** (`#app:not(.view-grid)
  #rail { display:none }`) — a launcher full of workspace tabs made no sense.
  View trips are pure CSS show/hide: the grid and its panes are NEVER unmounted
  (GL-warm + scrollback guarantees hold; smoke-asserted).
- **Settings is a page**, not a modal: left section nav (Appearance · Terminal ·
  Profiles & Hosts · Privacy · About) + a scrollable content column, built ONCE at
  mount so unsaved form text survives leave/return. Enter via the titlebar gear or
  `settings:open`; leave via Esc, the back affordance, or any titlebar view — the
  view port keeps ONE step of history (`goBack()`), so Settings returns wherever
  you came from. Real dialogs (wizard, review, card editor) stay modals.
- With zero workspaces, any road to the grid lands **Home** instead (the empty grid
  was a dead end — audit UX-16). The titlebar Home/Board/gear trio shows the active
  view (`.icon-btn.is-active`).
- Full-bleed rebalance: board lanes/head cap at `min(1440px, 100%)` centered; home
  sections widen to `min(1180px, 92%)`.

## Icons (Phase-5/03)

One family: 24×24 grid, **stroke 1.75**, round caps/joins — lucide-compatible
conventions, so future additions match. Inline SVG path strings only (no font, no
package, no build step). Most paths are vendored from Lucide (ISC — attribution in
`icons.ts`); ≤12px simplified variants are hand-drawn. Rendering rules in `icon()`:
**size ≤ 12px → stroke-width 2** (weight compensation) and the SMALL variant kicks
in where one exists (detail dropped, not squeezed). Rendered sizes are snapped to
{12, 14, 16, 24} — the old 10/11/13/15px calls were retired. Crispness verified by
icon-sheet shots at 100/125/150% zoom (`__mogging.iconSheet()`, DEV-only).

### Inventory & mapping (every `icon(` use)

| Icon | Surfaces | Decision (5/03) |
|---|---|---|
| `kanban` | titlebar Board | **redrawn** → framed board with three columns (was three floating lines — unreadable) |
| `home` | titlebar Home | **redrawn** → modern house w/ door (crisper silhouette) |
| `sliders` | titlebar Settings | **new metaphor** (two knobs) replacing the intricate gear — weight-matched to the line family at 16px; `settings` name deleted |
| `panel-left` | titlebar rail toggle | keep (standard sidebar toggle) |
| `expand` / `expand-h` / `expand-v` | pane actions | **new metaphors**: outward diagonal arrows / ↔ / ↕ with arrowheads — the old chevron pairs read as *collapse*; `maximize`, `chevrons-*` deleted |
| `more`, `x` | pane actions, menus, toasts | keep (universal) |
| `flag` | claims chip + "Show claims…" menu item | **new** — ownership flag replaces the borrowed `folder` and the `⛿` text glyph; pennant SMALL variant at chip size |
| `globe` | remote pane chip | **new** — the chip now carries a WHERE glyph, not just a name; one-meridian SMALL variant |
| `git-branch` | git chip, path status, review menu item | keep (the standard) |
| `check` | approved chip (was text `✓`), checkbox, stepper | keep |
| `info` | info toasts | **new** — info no longer borrows the bell |
| `bell` / `check-circle` / `alert` | toast tones, board attention chip, path status | keep |
| `terminal` | ws icon, quick terminal, board agent chip, launch menu | keep |
| `folder` / `folder-open` | path input, recents, copy-cwd | keep (real folder intents only, claims un-borrowed) |
| `layout-grid`, `plus`, `search`, `sparkles`, `pencil`, `trash`, `clock`, `bookmark`, `arrow-right`, `chevron-left` | launcher/menus/wizard | keep |
| *(deleted)* `command`, `enter`, `resume`, `minimize`, `chevron-down`, `chevron-right`, `settings`, `maximize`, `chevrons-left-right`, `chevrons-up-down` | — | unused or replaced; names never repurposed |

Deliberate non-icon: role chips (WORKER/REVIEWER) stay text-only — roles are
freeform strings, and the uppercase tag IS the clearest rendering; a generic badge
glyph would add noise, not intent. Every icon-only button carries `title` +
`aria-label` (grep-asserted; `IconButton` requires a label by type).

## Audit ledger

Walked from `out/gallery/` (46 shots, both themes, 2026-07-02). Shot refs use the
name suffix (numbering shifts as the gallery grows). **Fixed in 01** = pure-token
wins shipped with this step; everything else is LOGGED with its owner step.

| ID | Finding (measured where applicable) | Shot ref | Owner |
|---|---|---|---|
| UX-01 | `--text-lo` 4.36:1 on dark elevated (menus/modal captions) — under AA | dark-pane-menu | **fixed 01** |
| UX-02 | Semantic colors as text on light: success 2.16, warning 2.03, info 2.63, danger 3.44 — diff adds, "not found on PATH", errors washed out | light-review-gated, light-wizard-agents | **fixed 01** |
| UX-03 | Identity colors on light 1.5–2.7:1 — rail icon glyphs unreadable | light-grid-4-chips | **fixed 01** (ramp `--ws-ink`) |
| UX-04 | Amber identity (#fbbf24) sits 12° from brand orange — ordinals 7 vs 8 indistinguishable | dark-grid-4-chips | **fixed 01** (→ green `#4ade80`) |
| UX-05 | `.pane-remote` hard-coded `#58a6ff` (2.5:1 on white) | light-grid-4-chips | **fixed 01** (→ `--info`) |
| UX-06 | Board attention chip: white on accent 2.34:1 | dark-board-cards | **fixed 01** (→ `--accent-contrast`) |
| UX-07 | Dark layer muddiness: surface/elevated steps 1.07–1.15×, board lanes & rail blend into canvas | dark-board-empty, dark-home-empty | **fixed 01** (neutral re-tune) |
| UX-08 | Light elevation collapse: surface = elevated = `#ffffff` — cards on lanes, buttons on modals share one white | light-board-cards | **fixed 01** (3-step light stack) |
| UX-09 | Feature CSS defined its own scrims/selection rgba (palette 0.5, modal 0.62, ::selection) | — | **fixed 01** (`--scrim`, `--selection-bg`) |
| UX-10 | Text on accent fills in light (`#fff8ee`) 2.3:1 — primary buttons, wizard step dots, attention badges | light-wizard-start | **fixed 01** (`--accent-contrast #201200` both themes) |
| UX-11 | Nord/Solarized `--text-lo` 3.3 / 3.1 on their elevated | (theme switch) | **fixed 01** |
| UX-12 | Active workspace (brand outline) vs attention workspace (brand ring + glow) read nearly identically in the rail — selection must move to the workspace's OWN ramp | dark-rail-attention | **fixed 02** (identity selection treatment; attention → soft outer glow) |
| UX-13 | Role chips (WORKER / REVIEWER) are both accent-orange — roles indistinguishable from each other and from attention semantics | dark-grid-4-chips | **fixed 07** (chips neutral by default — orange means attention, never a role; `data-role='reviewer'` earns `--info`; a fuller per-role palette waits for real role proliferation, Phase 6) |
| UX-14 | Wizard `PROVIDER_COLORS` duplicates identity hues in TS; the Claude dot is near-brand orange (ambiguous with attention); `--cell-accent` is a second inline-style channel | dark-wizard-agents | ⏸ deferred → Phase 6 (Claude dot fixed in 03; the rest is a TS data palette with no user-facing defect — consolidation is refactor work, not polish) |
| UX-15 | Pane-header action cluster (5 always-visible icons) consumes ~⅓ of header width at 8/16-pane density — titles truncate early | dark-grid-16 | ⏸ deferred → Phase 6 (hover-reveal needs a density signal + a PANEOPS-safe interaction design; not a safe polish-window change) |
| UX-16 | Closing Board/wizard with zero workspaces lands on an EMPTY grid view (blank canvas, no CTA) — the gallery had to work around it | light-home-empty (first run) | **fixed 05** (`setActiveView('grid')` with zero workspaces routes Home) |
| UX-17 | Settings profile form: env-value input overflows the form's right edge (both themes) | dark-settings-profile-error | **fixed 05** (`minmax(0,…)` env-row columns; form inputs shrink) |
| UX-18 | Native `<select>` (wizard "Runs on", profile provider) doesn't match `.input` styling | dark-wizard-start | ⏸ deferred → Phase 6 (selects already carry `.input` sizing/colors; a custom chevron needs a color-literal data-URI — breaks the grep gate — or wrapper DOM) |
| UX-19 | Board empty lanes have no empty-state hint (only the dashed "+ Add card") | dark-board-empty | **fixed 05** (`.board-empty-hint` in the header when the board is empty) |
| UX-20 | Idle pane state dot `--border-strong` on light ≈1.9:1 — acceptably quiet, but header icon hover affordances are also dim on light | light-grid-4-chips | ✅ closed by design 07 (idle is DELIBERATELY the quiet state — busy/attention carry the signal; header icons sit at `--text-lo`, ≥4.5:1 on light after the 01 re-tune, with hover lift) |
| UX-21 | `--fs-10` was referenced 5× (role/claims/remote/board chips) but never DEFINED — the declarations were invalid and chips rendered at the inherited size | dark-grid-4-chips | **fixed 01** (`--fs-10: 10px`); remaining raw 9/10px literals → 03 |
| UX-22 | Rail header ("WORKSPACES n" + the `+` button) is 10px `--text-lo` — the primary creation entry point is the faintest thing in the rail | dark-home-empty | **fixed 02** (title → `--text-mid`; header edge-aligned with tab content) |
| UX-23 | `terminal-pane.ts` carries a hard-coded pre-mount xterm placeholder theme (corrected by the theme port on mount) — acceptable, but keep it in sync with `--bg-app`/`--text-hi` | — | ✅ closed 07 (documented sync obligation; the placeholder exists for one frame before the theme port replays) |

## Guardrails (how this stays true)

- **Grep gates** (run in CI-sized checks; all must return empty):
  - `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' src/ui/styles/global.css | awk -F: '$1 > 145'`
    → no color literals outside the token/theme-fallback blocks.
  - `grep -rn "@backend" src/ui --include='*.ts'` (and the inverse for `@ui`,
    `electron`, `node-pty`) → layer boundaries hold.
- The verification loop: `MOGGING_SHOT=all` regenerates `out/gallery/` (46 shots,
  both themes) in one command; before/after pairs live in `docs/assets/gallery/`.
- Token changes re-run SMOKE + PERCEPTION + MILESTONE — restyle never renames the
  load-bearing selectors (`.workspace-tab[data-attention]`, `.pane-state[data-state]`,
  `.pane-git.has-git`, `.layout-slot[data-pane-id]`, …).
