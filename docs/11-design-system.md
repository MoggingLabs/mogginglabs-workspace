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
| UX-13 | Role chips (WORKER / REVIEWER) are both accent-orange — roles indistinguishable from each other and from attention semantics | dark-grid-4-chips | 03 |
| UX-14 | Wizard `PROVIDER_COLORS` duplicates identity hues in TS; the Claude dot is near-brand orange (ambiguous with attention); `--cell-accent` is a second inline-style channel | dark-wizard-agents | 03 |
| UX-15 | Pane-header action cluster (5 always-visible icons) consumes ~⅓ of header width at 8/16-pane density — titles truncate early | dark-grid-16 | 03 |
| UX-16 | Closing Board/wizard with zero workspaces lands on an EMPTY grid view (blank canvas, no CTA) — the gallery had to work around it | light-home-empty (first run) | 05 |
| UX-17 | Settings profile form: env-value input overflows the form's right edge (both themes) | dark-settings-profile-error | 05 |
| UX-18 | Native `<select>` (wizard "Runs on", profile provider) doesn't match `.input` styling | dark-wizard-start | 05 |
| UX-19 | Board empty lanes have no empty-state hint (only the dashed "+ Add card") | dark-board-empty | 05 |
| UX-20 | Idle pane state dot `--border-strong` on light ≈1.9:1 — acceptably quiet, but header icon hover affordances are also dim on light | light-grid-4-chips | 06 |
| UX-21 | `--fs-10` was referenced 5× (role/claims/remote/board chips) but never DEFINED — the declarations were invalid and chips rendered at the inherited size | dark-grid-4-chips | **fixed 01** (`--fs-10: 10px`); remaining raw 9/10px literals → 03 |
| UX-22 | Rail header ("WORKSPACES n" + the `+` button) is 10px `--text-lo` — the primary creation entry point is the faintest thing in the rail | dark-home-empty | **fixed 02** (title → `--text-mid`; header edge-aligned with tab content) |
| UX-23 | `terminal-pane.ts` carries a hard-coded pre-mount xterm placeholder theme (corrected by the theme port on mount) — acceptable, but keep it in sync with `--bg-app`/`--text-hi` | — | note |

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
