# 11 — Design system (Phase-5/01: audit + color system)

The single source of truth for the token layer. Established by the Phase-5/01 audit:
every surface screenshotted in both themes (`MOGGING_SHOT=all` → `out/gallery/`),
every color claim below **measured** (WCAG 2.x relative-luminance contrast).
AA thresholds used: **4.5:1** for text/icon-grade ink, **3:1** for non-text UI.

> **Provenance, corrected in 8.5/04.** This page used to say "the math lives in the
> audit script". *There was no audit script* — `git log -S luminance` finds one
> commit whose only surviving trace is this prose and a few comments in `global.css`.
> Every AA number here was a claim re-derived by hand. The math now lives in
> `src/main/setshell-smoke.ts` (sRGB linearization → relative luminance → contrast,
> with real alpha compositing up the ancestor chain, because `--accent-weak` is an
> `rgba()` and measuring it against `transparent` scores it as pure black). It runs
> in **all four themes** on every text class the Settings shell introduces, and it
> fails the gate below 4.5:1. Worst measured ratio at 8.5/04: **4.71:1**.
>
> **Freeze before you measure.** The probe injects
> `*, *::before, *::after { transition: none !important; animation: none !important }`
> and removes it afterwards. Without that it is load-dependent: `.settings-nav-item`
> transitions `background` and `color`, `setTheme()` swaps `--accent-ink` /
> `--accent-weak`, and a busy machine leaves the fade mid-flight when
> `getComputedStyle` samples it. SETSHELL read **1.72:1** inside a 55-gate sweep and
> **4.71:1** standalone, on identical DOM. It also probes
> `.settings-nav-item:not(.is-active)` and `.settings-nav-item.is-active` as separate
> nodes: the active item is first in the DOM, so a bare selector measures it twice and
> silently never checks the other state. When 8.5/06 lifts the probe into
> `src/main/aa-probe.ts`, the freeze goes with it — **inside** the exported call, so a
> caller cannot forget what it never had to remember.
>
> **The shared probe, and what it caught at the freeze (8.5/09).** SETSHELL, HOMEUX,
> BOARDUX, FEEDBACKUX, CHROMEUX and DOCKUX all import `aa-probe.ts`; the UXMILESTONE
> gate then re-measures every **safety** surface through it in one composed world —
> the possession label, the consent copy, an attention chip, the review-gate
> indicator and the trail's "never sent anywhere" line — across all four themes. It
> earned its keep: it caught `--danger-ink` rendering on the *tinted* `--danger-weak`
> chip fill (`.cc-chip.is-failing`) at **4.45:1** on light — below AA on a composited
> ground the plain/inset measurements (worst 4.52) never covered. Light `--danger-ink`
> was darkened past the fill (`#c92e25` → `#c02820`, **~4.87:1** on the chip; strictly
> improves every light danger-as-words surface, none regressed) — the same ink≠fill
> split the dark themes already use. A check on a real composited ground, not a claim.

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

`WORKSPACE_COLORS` (`src/ui/features/workspace/model.ts`) holds one vivid identity color
per workspace. The rail controller stamps it inline as `--ws-accent` on the
`.workspace-tab` (the ONE sanctioned inline style); `global.css` derives the ramp per
theme via `color-mix` — consumers use ONLY the ramp stops:

| Stop | Derivation (dark) | Derivation (light) | Use |
|---|---|---|---|
| `--ws-accent` | the raw identity color | (same — washes/fills only) | vivid stop |
| `--ws-ink` | `color-mix(accent var(--ws-ink-mix), var(--text-hi))` — **per theme**, see below | (same formula) | text/icon-grade |
| `--ws-tint` | `color-mix(accent 12%, transparent)` | (same) | surface wash |
| `--ws-tint-hover` | `color-mix(accent 6%, transparent)` | (same) | hover whisper |
| `--ws-edge` | `= accent` | `= ink` | border-weight stop |
| `--ws-glow` | `color-mix(accent 42%, transparent)` | (same) | soft outer halo |

### The ink is per THEME, not per mode

`--ws-ink` used to ask one question — is this theme light or dark? — and dark themes all got
the same answer: *the ink is the accent*. That answer was measured on midnight and is only
true there. **"Dark" is not one surface.** The rail sits on `--bg-surface`, and midnight's is
`#15171c` while nord's is `#353c4a`; identity ink is painted ON an identity tint, so the
ground is dragged toward the ink and contrast is lightness alone. On nord, violet measured
**2.9:1** on the selected chip — and 4.0:1 on the *bare* rail, before any tint. Nord and
solarized had inherited midnight's answer, and **40 identity/surface pairs sat under AA**.

So each theme now states how much of the accent its own surfaces can carry (`--ws-ink-mix`,
in `themes.ts`) and the ink mixes the rest of the way toward that theme's `--text-hi` — up on
dark, down on light. This is the ramp's own stated philosophy ("vividness lives in the
accent/tint/glow stops; readability lives in ink/edge"), generalized from one mode to every
theme. **The accent never moves**: bars, borders, tints and glows stay exactly as vivid as
they were. Only the ink — the small glyph and the selected label — gives ground, and only
where its theme forces it to.

The percentages are **solved, not chosen**: the largest value (= the most vivid ink) that
holds 4.5:1 across all 12 identity colors on every ground the rail inks.

| Theme | `--ws-ink-mix` | worst identity contrast (any color, any ground) |
|---|---|---|
| midnight | `100%` — the accent IS the ink | 5.5 |
| solarized | `86%` | 4.5 |
| nord | `68%` — the lightest "dark" surface in the app | 4.5 |
| light | `46%` (was a flat 54% toward pure *black*) | 4.5 |

Two surfaces had to give way for those numbers to be reachable at all:

- **The selected chip stopped stacking a second wash.** `.active .ws-icon` painted `--ws-tint`
  over a tab already painted `--ws-tint` — 22.6% of the accent directly under ink of the same
  hue. It was the tightest surface in the rail, it bought almost nothing (a 22.6% wash barely
  steps off a 12% one), and it cost the most exactly where the ink could least afford it. The
  chip is now `transparent` on the selected row: it stops being a well and joins the row.
  Dropping it is what lets nord keep 68% of its accent instead of 51%, and solarized 86%
  instead of 65%.
- **The selection bar reads `--ws-edge`, not `--ws-accent`.** On light, a vivid accent on a
  near-white row measured **1.5–2.4:1** — the loudest mark of the selected state was
  invisible in one of the four themes. The edge stop is precisely the "as vivid as this
  theme's ground allows" answer, and it is what the outline beside it already used. On dark
  the two are the same value, so nothing moves.

Gated by **CHROMEUX (m)**: all 12 colors × 4 themes × both grounds (the `--bg-inset` chip at
rest, and the 12% identity wash when lit), measured through `aa-probe.ts`. Worst measured
**4.51:1**. It is probed *by ordinal* — (g) already probed `.ws-label`, and that is exactly
why this hid for so long: `querySelector` takes the first match, the first tab is teal, and
teal is one of the few identity colors that passed. The bug was never in the selector; it was
in *which color the selector happened to land on*.

### Rail selection spec (Phase-5/02)

The selected workspace lights up in ITS color; selection is the only loud thing in
the rail. States, quiet → loud (all ramp stops — no per-feature color):

| State | Treatment |
|---|---|
| rest | neutral `--text-mid` label, identity only on the icon glyph (`--ws-ink` on a `--bg-inset` chip) |
| hover | `--ws-tint-hover` wash (6% identity whisper) |
| press | full `--ws-tint` |
| **working** | agents running, background tabs only: the CHIP lights in the tab's own ramp (`--ws-tint` fill + 1px inset `--ws-edge`). Quiet, static, and identity-only — see the glyph rule below |
| **selected** | `--ws-tint` across the button + 1px `--ws-edge` outline + **4px selection bar** (`::before` overlay in `--ws-edge`, pill ends, spanning only the STRAIGHT run of the left edge — vertical insets = the corner radius — floating 1px off the outline; zero layout shift, geometry-probed) + label/icon in `--ws-ink`. The chip goes `transparent` here — it joins the row's wash rather than stacking a second one over it (see the ink section: that stack was the rail's tightest surface) |
| focus-visible | the global 2px brand focus ring (interaction ≠ selection) |
| drag | 0.55 ghost opacity |

**The glyph is the identity, and no state may repaint it.** At rest it is the only thing
carrying the workspace's color — the row itself is neutral until hover or selection — so a
rule that sets `.ws-icon { color: … }` to anything but `--ws-ink` does not add a state, it
*deletes the workspace's identity and substitutes its own*. One did: `.is-working` painted
the glyph `--success`, which (a) desynced a busy background workspace's icon from the color
its own row lights up in — teal tab, green icon; (b) turned EVERY busy workspace the same
green, so the rail lost identity exactly when several agents were running; and (c) spent
green, which the verdict law reserves for *finished*. States decorate the chip. The glyph
stays `--ws-ink`.

**Attention stays brand orange** — it means "needs you", never "which one is active".
The latched ring is a soft outer glow (`0 0 0 1px --accent-glow, 0 0 14px --accent-glow`
— no hard border), so a ringing neighbor composes with a vivid selected tab. The
active workspace never rings (Phase-2 semantics, smoke-asserted) but its live
`.ws-attn` badge still shows; a combined rule keeps bar-inside/glow-outside readable
if both states ever co-occur. Label overflow fades via an alpha `mask-image` instead
of "…". Contrast: every identity ink holds **≥4.5:1** on both grounds the rail paints it on,
in all 12 colors × all 4 themes — worst 4.51:1, gated by CHROMEUX (m). (The old claim here
read "≥4.8:1 light / ≥5.5:1 dark for all 8 identities", and it was measured on midnight and
white only; nord's violet was 2.9:1 the whole time.) The `no-layout-shift` guarantee
is asserted by `out/gallery/probe-rail.json` (tab width + icon x equal, selected vs
not, within 0.5px).

### The 12 identity colors — measured

Recalibrated in 01: **amber `#fbbf24` → green `#4ade80`** (amber sat 12° from brand
orange — with 7+ workspaces open the two were indistinguishable at rail-icon size)
and **lime `#a3e635` → `#9bdf2f`** (so its light ink stop clears 4.5 on the tint
wash).

**Assigned by allocation, not by ordinal.** `nextColor(taken)` hands a new workspace the
first color no LIVE workspace is wearing, and the choice is then persisted and restored, so
a workspace keeps its color for life. It used to be `WORKSPACE_COLORS[ordinal % 8]` — and
the ordinal is a pane-id anchor, so it only ever climbs and is never recycled. Open a few
workspaces, close a few, and the counter walks past 8 and starts re-issuing colors that are
already on screen; ordinals 0 and 8 are both teal, so **two** open workspaces were enough to
collide. (A real store had brand orange twice.) Allocating against the live set makes that
unrepresentable while the palette holds.

Which makes the palette's SIZE the number of workspaces that can be open at once and all
look different — so it grew to twelve. The four additions sit in the four widest gaps of the
existing hue wheel and hold the same **22.4° minimum separation the original eight already
had** (lime/green). Sixteen was measured and rejected: it could only be bought by halving
that separation, and the extra hues landed on brand orange, which is spoken for. Past twelve
reuse is forced — `nextColor` then returns the least-worn color, so overflow spreads instead
of piling onto one hue.

The accent is the identity and never changes. The **ink** is what each theme can carry of it
(`--ws-ink-mix`, above) — so it is listed per theme, and the last column is the worst contrast
that color reaches anywhere: any theme, either ground.

| # | Name | `--ws-accent` | accent on dark app | midnight ink | light ink | nord ink | solarized ink | worst AA |
|---|---|---|---|---|---|---|---|---|
| 1 | teal | `#2dd4bf` | 10.4 | `#2dd4bf` | `#206e66` | `#6addd0` | `#48d7c2` | 5.0 |
| 2 | violet | `#a78bfa` | 7.1 | `#a78bfa` | `#584c82` | `#bdabf8` | `#b198f5` | 4.5 |
| 3 | sky | `#38bdf8` | 9.1 | `#38bdf8` | `#256381` | `#72cdf7` | `#51c3f3` | 5.0 |
| 4 | rose | `#fb7185` | 7.2 | `#fb7185` | `#7f404c` | `#f699a9` | `#f98290` | 4.5 |
| 5 | lime | `#9bdf2f` | 12.0 | `#9bdf2f` | `#537324` | `#b5e46e` | `#a7e046` | 4.5 |
| 6 | magenta | `#e879f9` | 7.9 | `#e879f9` | `#764481` | `#e99ff7` | `#e989f4` | 4.7 |
| 7 | green | `#4ade80` | 11.2 | `#4ade80` | `#2d7349` | `#7ee3a5` | `#61df8c` | 4.8 |
| 8 | brand | `#fd8d03` | 8.3 | `#fd8d03` | `#804d10` | `#f8ac50` | `#fb9a20` | 4.9 |
| 9 | cyan | `#1fdef2` | 11.8 | `#1fdef2` | `#1a737e` | `#61e3f3` | `#3cdfee` | 4.6 |
| 10 | cornflower | `#71a0fe` | 7.6 | `#71a0fe` | `#3f5683` | `#98b9fb` | `#83aaf8` | 4.6 |
| 11 | yellow | `#e2c456` | 11.4 | `#e2c456` | `#736736` | `#e5d289` | `#e4c968` | 4.7 |
| 12 | pink | `#ff99cf` | 9.9 | `#ff99cf` | `#81536e` | `#f9b5db` | `#fda4d0` | 5.1 |

Every accent is ≥7:1 on the dark app (text-grade with margin, and it is what the bars, edges,
tints and glows are drawn from). Every **ink** is ≥4.5:1 in its own theme on both grounds the
rail paints it on — the opaque `--bg-inset` chip at rest, and the 12% identity wash when the
tab is selected or working. Vividness lives in the accent/tint/glow stops; readability lives
in ink/edge — neither sacrifices the other. Worst measured anywhere: **4.51:1** (solarized
violet, lit). The four additions were computed against the same law and clear it outright.

**A restore repairs the rail.** Both failures the old derivation could write are already on
disk — outright duplicates, and hexes from palettes since retired (`#b5d21b`). `resolveColors`
settles the whole restored set in two passes: every workspace with a good claim (still one of
ours, nobody ahead of it wearing it) keeps its color first, and only then is anything
allocated — so a claim that must be re-colored can never evict a color a later workspace
legitimately owns. Only the broken claims move.

## Scales (as they actually are)

- **Type** (`--fs-*`): 11 · 12 · 13 (base) · 14 · 16 · 20 · 24 · 28 px, JetBrains Mono
  Variable everywhere (`--font-ui` = `--font-mono`). Weights 400/500/600/700
  (`--fw-regular/medium/semibold/bold`). Tracking: `--track-tight -0.035em` (headings),
  `--track-wide 0.14em` (uppercase labels). One un-tokenized stragglers set exists at
  9–10px in chips/kbd (logged as UX-21).
- **Space** (`--sp-1…8`): 4 · 8 · 12 · 16 · 24 · 32 · **48 · 64** px (4-base). The
  6-stop ramp topped out below page-level rhythm, so **8.5/01 extended it** —
  `--sp-7: 48`, `--sp-8: 64` — rather than fork a parallel `--space-*` scale across the
  277 existing `--sp-*` call sites (AUDIT § Deviations 1: *extend, never bypass*). Two
  readable-column caps ride alongside: `--measure: 68ch` (prose/captions — it resolved
  the app's old 52ch-vs-72ch split) and `--page-max: 1040px` (the settings/home
  column). The drift gate `scripts/check-spacing.mjs` enforces the ramp — no spacing
  declaration may carry a px literal outside **{0, 1, 2, 3, 6}** (1–2px hairlines,
  3/6px dense-terminal-chrome half-steps) — and **8.5/09 froze it at `--max 0`**, every
  bucket zero including the shared row. (01 first shipped this rule as an awk one-liner
  that reported 94 violations where there were 33 — mawk silently ignores `\b`; the node
  script is the reproducible replacement.)
  Rhythm rules (6/UI pass — every new surface inherits these for free):
  - **The division**: where a title heads a content column, the junction is
    title → `sp-3` → 1px hairline (`--border` at 55%, inset to the content
    column) → section gap (≥ `sp-3`) → content. Implemented on the rail
    header, home + settings `.section-label`s, board lane heads, and modal
    footers (line above, since the body scrolls under them). Small inline
    cluster labels (wizard "Your grid") stay bare.
  - **Clip room**: outer effects (attention rings, glows, shadows) need their
    breathing space INSIDE the scroll container that clips them — the
    title/list gap lives as the scroller's `padding-top`, never as the
    header's `padding-bottom` alone.
  - **Minimum sibling gap**: interactive neighbors keep ≥ `sp-1`; dense
    terminal chrome (pane-header clusters, chips, icon tiles, kbd hints) may
    use 3/6px optical half-steps — the ONLY sanctioned off-ramp spacing
    (policy note at the token block).
  - **Menus size to content** (`width: max-content`, capped): an item that
    wraps reads broken, not compact.
- **Radius**: `--r-xs 3` · `--r-sm 6` · `--r-md 10` · `--r-lg 14` · `--r-full 999` px;
  terminals are deliberately square (`border-radius: 0` on `.layout-slot`). `--r-xs` is
  the dense-terminal-chrome stop — see § Chrome refinements for the 8.5/08 decision.
- **Elevation**: `--shadow-1/2/3` (per-theme alpha); dark leans on surface steps,
  light on shadows + borders.
- **Motion**: `--dur-1 120ms` · `--dur-2 200ms`, `--ease cubic-bezier(.2,0,0,1)`;
  reduced-motion collapses all to ~0.
- **Layout**: `--rail-w 288px` · `--rail-w-collapsed 60px` · `--titlebar-h 40px`.

## Layout primitives (Phase-8.5/01)

The 8.5 audit's headline finding was not "no scale" (a scale existed, used 277 times)
but **no structural vocabulary**: there was not one `Card` in the app, and
`.settings-row` — a bare `flex column; gap: 8px`, no border/background/padding — was
asked to hold a full CRUD manager. Sections and rows read identically. 8.5/01 shipped
the missing pieces (`src/ui/components/`, `el()`-built, token-only CSS, exported from
`components/index.ts`); every later step consumes them and `check-spacing.mjs` gates
the result. The rhythm numbers are the convention answers (Geist/shadcn, re-derived
clean-room — patterns in, our code out; ADR 0004): *card gap ≤ card padding, or cards
stop reading as a group.*

- **`Card`** — the grouping primitive: `--sp-4` padding, `--sp-4` inter-card gap,
  `--r-md` corners, one border + one surface step. The collapsible variant
  (`.collapsible-card`) folds its body via `grid-template-rows: 0fr → 1fr`
  (Chromium-native here, no ResizeObserver) and keeps an always-visible header an
  attention chip can ride **even while collapsed** — collapse is not hide.
- **`SectionHeader`** — title + optional caption + optional action, built on **grid +
  `:has()`**, not flexbox: the action spans both rows and pins top-right, so a two-line
  caption never vertically re-centers the button (the one place flexbox
  `space-between` gets it wrong). The highest-value pattern the research surfaced.
- **`FieldGroup`** — label → control → hint, wired for a11y: `<label for>`,
  `role="group"`, `aria-describedby`, `aria-invalid`, `role="alert"` on the error. The
  hint sits under the **label** (matching the house `.settings-row`) — 8px
  label→control, 4px label→hint; `hintPlacement: 'below-control'` for caveat hints.
- **`TwoColumn`** — the page frame (a nav/rail column beside a content column) behind
  the Settings shell and Home; first *feature* customer 8.5/04.

Supporting primitives the pack generalized or gave first callers: **`EmptyState`**
(header capped at 384px so it reads as a message, not a paragraph; its `action?: Node`
finally has callers — the empty board lane), **`CountBadge`** (`tabular-nums`, so lane
counts don't jitter as cards drag), and the one **feedback family** (`Toast` /
`confirm` / `modal`: one radius, one stacking gap, one motion curve in AND out; the
destructive `confirm` focuses the safe action and can never be silenced).

## Tooltips (Phase-11.6) — *planned, not built*

Every hover hint in the app is still a native `title` attribute: **the OS draws it**, in its
own white box, and nothing in this file reaches it — the token system stops at the window's
edge. ~180 of them (≈130 via `el({ title })` → `components/dom.ts:42`, ~50 direct
`.title =`, over half in `terminal-pane.ts`). 11.6 takes the surface back, the same move
11.5 made on scrollbars.

**The rule: `title` stays the *authoring* API.** `el({ title })` and `.title =` keep working
exactly as they do today; a single delegated controller (`src/ui/core/tooltip/`) owns the
*display*:

1. on pointer-enter / `focus-visible` of `closest('[title]')` — read the text, **remove the
   attribute** (the only thing that stops the OS painting), stash it in a `WeakMap`;
2. render a themed node after ~400ms (0ms while another tooltip is already open — the warm
   path);
3. on leave / `Esc` / scroll / pointer-down — hide, and **put the attribute back**.

At rest the DOM is unchanged, so `element.title` stays readable — which is **load-bearing**:
`explorer/index.ts:773`/`:813` find file rows by it and five gates assert on it. That is why
we did **not** migrate to `data-tooltip`; the rename would have been a ~180-site diff that
broke working gates for no user-visible gain. A `MutationObserver` on the hovered element's
`title` catches the titles that change *during* a hover (`updates/index.ts:86` ticks a
download percentage; the pane state dot flips idle→busy) — without it the native box returns
mid-hover and our text goes stale.

**The surface** is the `.menu` recipe, so tooltips and menus read as one material:

```css
.tooltip {
  position: fixed;
  z-index: 250;                 /* above .toast-host (200), below .usage-confetti */
  max-width: 380px;
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  color: var(--text-hi);
  box-shadow: var(--shadow-2);
  font-size: var(--fs-12);
  white-space: pre-line;        /* git-display.ts:100 joins its lines with \n */
  pointer-events: none;
}
```

Token-only, so it follows every theme `themes.ts` stamps — the eight identity themes and
whatever is added later — with **no per-theme rule**. `pre-line` is not a nicety: the git
chip's title is a six-line block, and without it the tooltip renders as one run-on line.

**The ladder.** `250` is deliberate. A tooltip must never be occluded by the surface it is
anchored *inside*, and elements carrying titles live inside menus (40/60), modals (100), the
palette (150) and toasts (200). `pointer-events: none` means sitting on top of all of them
costs nothing.

**Position** is a rect clamp, not a library (ADR 0004; zero new deps): prefer below-centered
on the trigger's `getBoundingClientRect()`, flip above on bottom overflow, clamp horizontally
into the viewport. One constraint the window imposes — DOM cannot paint over Windows'
`titleBarOverlay`, so titlebar-button tooltips must open **downward**; the clamp gives that
for free.

**A11y contract** — an upgrade, not a re-skin, since native `title` did none of it:
`role="tooltip"` on the node; `aria-describedby` on the trigger while shown (the house
pattern already — `field-group.ts:51`, `toggle-row.ts:51`); opens on `focus-visible`, so
keyboard users get the text at all; `Esc` dismisses; no motion under `:root.motion-calm`.
Screen readers are unaffected — they read `title` at rest, and at rest it is still there.

**Opt-out**: `data-no-tooltip`, for the places `title` carries data rather than microcopy.

**Out of scope, permanently**: the Windows taskbar/shortcut tooltip (the "MLW" box) is drawn
by the shell, outside the renderer. No app-side fix exists — the honest answer is to say so.

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
- **Under compression the bar reorganizes — it never overlaps.** TRUE center prices
  the bar at ~890px (the 1fr sides are equal, so the rigid right cluster — ~300px
  with the controls reserve — counts double). Below 900px the grid trades true
  center for content-sized sides (`auto minmax(0,1fr) auto`; the command box centers
  in the *remaining* space, VS Code's trade) and sheds ornaments outermost-first:
  version (900) → brand name (760; the logo stays, like the Win-titlebar icon) →
  below the floor, kbd hint (560) → label (480). Cluster children are `flex: none` —
  a squeezed bar never shrink-distorts icons or hit targets (the 29px contract in
  the CHROMEUX (a) gate holds at every width). The floor is real: `window.ts` sets
  `minWidth 600 × minHeight 400` (VS Code ships 400×270, but its bar is sparser —
  our controls reserve alone is 140px). The ladder and the floor are a pair: move
  one, re-walk the other.
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

## Chrome refinements (Phase-8.5/08)

The audit graded the three chrome surfaces high but not A, and left one token decision
open. This step closed all three and the decision.

- **The radius ramp gained an off-ramp: `--r-xs: 3px`.** The ramp was `--r-sm/md/lg/full`
  with no stop below 6px, yet dense chrome shipped 3px, 4px and 5px radii with no token
  behind three of them — the audit's "last unresolved either/or." **Decision: add
  `--r-xs: 3px` rather than fold 3px into `--r-sm`.** Folding would double the corner on
  the 14–16px pane-header chips (remote/role/claims/mcp), the rename inputs and the ⋯
  buttons, making crisp dense chrome read as pills — the opposite of the standing
  terminal-chrome rule that keeps panes square. So 3px earns a named stop; the accidental
  4px/5px drift collapses onto the nearest one (4→`--r-xs`, 5→`--r-sm`). The ramp is now
  `3 · 6 · 10 · 14 · 999`. CHROMEUX (f) grep-asserts no un-tokened radius remains in the
  titlebar/rail/pane chrome. (Browser-dock + shortcuts radii are 08b's.)
- **The right cluster's order is declared in one place.** `titlebar.ts`'s single
  `cluster.append(titlebarLeft, titlebarRight, Board, Settings, titlebarEnd)` IS the
  canonical left→right order — previously it was incidental feature-registration order,
  and `feature-registry.ts` mis-documented `titlebarLeft` as "after the brand." It is in
  fact the LEADING feature slot *inside* `.titlebar-right` (the brand cell holds only
  logo/name/version). Two things are NOT in this cluster, and neither is an oversight:
  there is **no Home button** (Home is the boot launcher and the zero-workspace empty
  state, never a destination — see Full-app views below), and the **rail toggle** leads
  `.titlebar-lead` at the far left, over the rail it collapses, which is exactly why
  `titlebarEnd` (11/03) closes the right cluster for the explorer's toggle: a toggle
  belongs over the thing it opens. Both docs are corrected; nothing renders differently.
- **The macOS traffic-light inset is a token, not a magic literal.**
  `--traffic-light-inset: 84px` (the darwin brand's left padding) is coupled by comment
  to `main/window.ts`'s `trafficLightPosition: { x: 14 }` — the darwin twin of the
  Windows `--controls-reserve`. Keep the value; the coupling is now visible from both ends.
- **The rail earns a scroll affordance.** `#workspace-tabs` masks the edge it can scroll
  PAST (`fade-top`/`fade-bot`, toggled from scroll position + overflow) — the vertical twin
  of `.ws-label`'s edge mask — so an 8+ workspace roster reads as scrollable, not clipped.
  Only a scrolled-past edge fades, so a fully-visible tab is never masked and the loud
  `.ws-attn` count is never dimmed (attention is never dimmed — guardrail). Tabs also gained
  `flex: none`: they take their natural height and the list scrolls, rather than shrinking.
- **Four bugs, closed** (audit § Bugs): **#9** `.pane-head-left { overflow: hidden }` (the
  chips clip instead of spilling into the branch chip) + `.pane-role` gains a `max-width`
  and hover tooltip; **#10** the collapsed-rail agent-browsing dot drops to the bottom so
  it stops colliding with the `.ws-attn` count on one 8px corner; **#11**
  `#app:not(.view-grid) .layout-launcher { display: none }` (the grid button is absent
  where there is no grid to re-grid); **#12** the remote chip moved into the ordered
  append so the state dot is again the leading glyph. All asserted by CHROMEUX (a–g),
  `out/chromeux-result.json`.

## Possession & consent chrome (Phase-8.5/08b)

AUDIT § Blockers #1 — the pack's most serious finding — is discharged here: the surface
that tells a user an agent holds the wheel of their browser had no CSS rule and no test.

- **The possession spans get rules of their own.** `.browser-agent-label`,
  `.browser-confirm-text` and `.browser-agentweb-note-text` were unstyled, inheriting
  `--fs-11`. Each now owns a rule — a step up in size, weight where it earns it, and
  `--text-hi` — so the possession message, the session-scoped consent question, and the
  persistence-honesty line (ADR 0002) read, and can never silently regress to a bare span.
- **AA on the safety text, and a gate that says so.** The label measured **4.35:1 on nord**
  (accent-ink over the accent wash) — below AA, with nothing to object. It is `--text-hi`
  now (worst 7.93:1 across four themes). The DOCKUX guard — written and watched green
  BEFORE the restyle — asserts the possession surface is present, hit-testable, legible and
  AA while `driving === true`, and absent while idle. Safety surfaces may be restyled,
  never dimmed; if a restyle needs the guard relaxed, the restyle is wrong.
- **Dock controls are real hit targets.** The possession/consent/agent-web text buttons
  (`.browser-agent-stop`, `.browser-confirm-btn`, `.browser-agentweb-sites`,
  `.browser-profile-opt`) reach `min-height: 28px` (the 26px shared `.icon-btn` is the
  sanctioned primitive, unchanged). REMOVE #13 (the empty `.browser-ws-chip:hover`) and #14
  (a dead `is-hidden` toggle) are cleared.
- **The shortcuts sheet is a two-column subgrid.** `.shortcuts-row` is a `subgrid` row, so
  every label/keys pair aligns to one column pair across the whole sheet. Its `5px` row
  padding → `--sp-1` — the `chrome` bucket's last spacing violation, so the bucket (and
  every bucket) is now **0** — and the raw `0.08em` title tracking → `--track-wide`. The `?`
  overlay and Settings § Shortcuts render the one SHORTCUTS source (KB-01); DOCKUX (d)
  asserts their row counts are equal.

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

- `AppView = 'home' | 'grid' | 'board' | 'settings' | 'wizard'`. Exactly one
  top-level view owns everything below the titlebar; `#app.view-<x>` (and
  `#content.view-<x>`) classes route it. The **rail renders in the grid and the
  wizard** (`#app:not(.view-grid):not(.view-wizard) #rail { display:none }`) —
  a launcher full of workspace tabs made no sense, but the wizard is the grid's
  own setup page, so you pick the next workspace beside the ones you have.
  View trips are pure CSS show/hide: the grid and its panes are NEVER unmounted
  (GL-warm + scrollback guarantees hold; smoke-asserted).
- **Settings is a page**, not a modal: left section nav (Appearance · Terminal ·
  Profiles & Hosts · Privacy · About) + a scrollable content column, built ONCE at
  mount so unsaved form text survives leave/return. Enter via the titlebar gear or
  `settings:open`; leave via Esc, the back affordance, or any titlebar view — the
  view port keeps ONE step of history (`goBack()`), so Settings returns wherever
  you came from.
- **The new-workspace wizard is a page too** (8.5/02): `#view-wizard`, one
  scrollable column of three Cards (Where · Layout · Agents) at `--page-max` with
  `--sp-6` gutters — and it is the ONLY non-grid view that keeps the workspace
  rail up, because you configure the next workspace alongside the ones you have.
  Esc / Cancel `goBack()`. Real dialogs (review, card editor, confirms) stay modals.
- With zero workspaces, any road to the grid lands **Home** instead (the empty grid
  was a dead end — audit UX-16) — **and the converse is enforced too**: with a workspace
  in existence, any road to Home lands on the **grid** (`view-port.ts`). Home and the
  grid are two halves of one invariant, and the workspace count decides which is right.
  So Home is the launcher and the zero-workspace empty state, **never a destination** —
  there is no Home button, no shortcut, no command, by design. Its two contents (recents,
  presets) are fully carried by the wizard, which is reachable at any time (Ctrl+T); a
  permanent Home entry would only re-open the dead end UX-16 closed. The titlebar
  Board/gear **pair** shows the active view (`.icon-btn.is-active`); HOMEUX (g) asserts
  both halves — the grid lands, and no Home affordance exists in the titlebar.
- Full-bleed rebalance: board lanes/head cap at `min(1440px, 100%)` centered; home
  sections widen to `min(1180px, 92%)`.

## The Settings shell (Phase-8.5/04)

`TwoColumn`'s first *feature* customer. A grouped nav rail | a scrolling column of
`Card`s — no bare-control walls left outside Integrations and Usage (step 05).

- **The nav is a map, not a list.** Flat rows say only how many there are. Four
  named groups — Workspace · Agents & tools · Trust · System — plus one icon per tab
  say *where a knob lives* before you read a label. Grouping is visual: every knob
  keeps its tab, every tab keeps its `data-target` id, and a tab absent from
  `NAV_GROUPS` is appended (and warned about in DEV) rather than silently dropped.
  Nav order is therefore deliberately **not** section order; SETSHELL asserts both.
  The tab split (post-8.5): Webhooks (the event bridge) sits under Agents & tools,
  and Activity (the agent audit trail) under Trust — neither is an MCP knob, so
  neither lives inside Integrations anymore.
- **One knob, one head.** A `Card` holding a single control uses its own
  `SectionHeader` as that control's label — nesting a `FieldGroup` there would print
  the name twice. Cards with two or more knobs give each one a `FieldGroup`.
- **`ToggleRow`, not `Checkbox`, for settings.** A switch means "this is on, now, and
  it applies immediately"; a checkbox means "include this in what I submit". The
  consent toggles are switches; the wizard's worktree box and the folder browser's
  "show hidden" stay checkboxes. `setChecked()` never fires `onChange` — that is what
  keeps `pullConsent()` from pushing straight back.
- **Consent copy keeps every clause** (ADR 0002/0005 wording is load-bearing); it
  gains layout, not edits — a card caption, a hint under each switch, and the scope
  sentence as `.settings-scope` beneath the toggles it qualifies.
- **Compatibility surface.** `#view-settings`, `.settings-page`, `.settings-nav-item[data-target]`
  + `.is-active`, `.settings-back`, `.settings-content` (the scroll parent), and
  `.settings-section[data-section]` with `hidden` semantics are all clicked or read by
  KBSHORTCUTS, PROFILES, INTEGUX, USAGESET, WEBTRAIL and the gallery. Restyle around
  them, never rename them.
- **`.settings-error` takes `--danger-ink`.** The fill red measures 2.93:1 on nord's
  elevated surface — below AA as words. The light *first-paint* media block overrides
  `--danger` but not `--danger-ink`, so that gap is closed too; without it, the fix
  would have made the pre-JS window worse (≈2.2:1) than the bug.

## The folder browser (Phase-8.5/03)

The wizard's Where card offers three views of ONE selection — a typed path bar, a
small current-folder line, and a click-through browser. They cannot disagree,
because none of them owns the path: `features/wizard/path-selection.ts` does.

**The single source of truth.** Every change names its ORIGIN (`bar` · `browser` ·
`recent` · `native` · `prefill` · `remote` · `reveal`), and the view that *caused* a
change is never written back to — so a ping-pong cycle does not form, rather than
being broken by "silent" setters. Exactly one resolve runs per change and its reply
is discarded unless it is still the newest (a monotonic token), so a slow `listDir`
can never drag the user backwards. Typing is debounced in the controller, not the
bar: `cwd` moves on the first keystroke (Launch validates against what you see)
while the filesystem is asked once, 350ms later — and `Enter` awaits `settle()`
rather than racing it. A `browser` origin already holds its listing, so it costs one
`git:query` and no second `listDir`.

The invariant — *with no refusal and no remote host, `cwd`, the bar's text, and the
browser's selection are one value* — is exposed as `window.__mogging.wizardPath()`
and re-asserted by FOLDERPICK after every interaction.

**Looking is not choosing.** A fresh wizard `reveal()`s your home directory: the
browser shows it, nothing is selected, `cwd` stays empty. `$HOME` never silently
becomes a workspace root, and Launch still says "pick a folder first". Likewise a
half-typed path leaves the browser exactly where it is (only the bar warns), and
Launch declines a path the filesystem refused instead of stranding every pane in it.

- **Directories only, one level, on demand.** No recursive walk, no watcher, no
  index, no file contents. The panel's footer says so where the user reads it.
- **All path arithmetic lives in the main process** (`@backend/features/fs-browse`,
  Electron-free and unit-tested). A listing ships every child's absolute `path` and
  a ready-made `crumbs` trail, so `@ui` never joins or splits a path — the only way
  Windows drive roots are representable at all. The virtual parent of `C:\` is
  `FS_DRIVE_ROOT` (`''`), whose listing is the drive letters; on POSIX the parent of
  `/` is `null`, because `/` really is the top.
- **Canonical, not resolved.** `C:/Users/` and `C:\Users` normalize to one spelling
  so the bar and the browser agree. Deliberately NOT `realpath`: a symlinked project
  folder is the path the user meant, and resolving it would teleport them to the target.
- **Symlinked directories are listed.** `Dirent.isDirectory()` is FALSE for a junction
  pointing at a folder, so links get a guarded stat; a dead link is skipped.
- **A refusal is a state, never a throw.** `denied` · `missing` · `not-a-directory` ·
  `invalid` each render a titled explanation in the list area. An unreadable folder is
  an ordinary thing to click on.
- **Cheap by construction.** Sort, cap at `FS_LIST_CAP` (500), *then* probe `.git` — a
  10k-entry folder costs 500 stats, not 10k. `truncated` says so out loud.
- **Selection model.** Arriving in a folder selects it (the last breadcrumb fills in).
  Clicking a row selects that child — one click to pick. Enter, double-click, or right-arrow
  descends. Selection is always exactly one real directory. Roving tabindex + real
  focus (the `grid-preview` pattern), `role="listbox"`/`option`, Home/End, Backspace
  ascends, printable keys filter, and Esc clears the filter *before* the page's Esc
  can leave the view.
- **Never for a remote workspace.** Choosing an SSH host hides the browser: that cwd
  lives on the other machine, and listing this disk would answer a question nobody asked.

Gallery shots open on a synthetic fixture at a path whose every segment is safe to
publish (`C:\mogging-showcase`, not a temp dir under `C:\Users\<name>`) — a folder
browser photographs whatever it is pointed at, breadcrumbs render every segment,
and screenshots are committed.

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
| `home` | palette group glyph (App) | **redrawn** → modern house w/ door (crisper silhouette). The titlebar Home button it was drawn for is **gone** (Home is not a destination — see Full-app views); the name survives on the one surface that still means "the app itself" |
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
| `chevron-right` | breadcrumb separators, disclosure chevrons | **re-added 8.5** (deleted in 5/03 when unused; a name is never *repurposed*, and this is the same metaphor) |
| `shield` · `user` · `plug` · `gauge` · `keyboard` | Settings nav (Trust · Profiles · Integrations · Usage · Shortcuts) | **new 8.5/04** — a nav of nine identical rows is a list, not a map. `keyboard` gets a SMALL variant: eight key-dots smudge below 12px, so the frame + spacebar carry it |
| `bell` · `activity` | Settings nav (Webhooks · Activity) | **tab split** — the event bridge and the audit trail left Integrations for their own tabs; `bell` was already the notify metaphor, `activity` is the Lucide pulse line |
| *(deleted)* `command`, `enter`, `resume`, `minimize`, `chevron-down`, `settings`, `maximize`, `chevrons-left-right`, `chevrons-up-down` | — | unused or replaced; names never repurposed |

Deliberate non-icon: role chips (WORKER/REVIEWER) stay text-only — roles are
freeform strings, and the uppercase tag IS the clearest rendering; a generic badge
glyph would add noise, not intent. Every icon-only button carries `title` +
`aria-label` (grep-asserted; `IconButton` requires a label by type).

## Usage surfaces (Phase-7)

The usage meters joined the system in Phase 7; every state is fixture-driven
and gallery-verified in both themes (`*-usage-*.png`).

### The titlebar gauge — icon states

Two 14×3px tracks (`--surface-3` base, `--accent` fill), stacked (session
over weekly), inside a standard `.icon-btn`. All state flips are PAINT-ONLY
(class + width), measured 15.6–22.7ms popover open against the 100ms budget.

| State | Treatment |
|---|---|
| rest | accent fills at the mirrored plan's percentages |
| `is-warn` | fills flip to `--warning` (verdict = runs-out) |
| `is-stale` | whole icon at 0.45 opacity (old data, honestly dimmed) |
| `is-off` | empty outlined tracks (`--text-dim` border) — nothing configured |
| ≥90% badge | 6px `--warning` dot, top-right, `--surface-1` ring (the attention-badge idiom) |
| incident overlay | 6px `--danger` dot, bottom-right — "they're down", one glyph, never a takeover |
| content options (7/10) | glyph / `%` / label spans ALWAYS exist; `show-*`/`hide-bars` classes decide paint — structure never changes |

### Popover anatomy (the glance)

`.menu` panel (`--bg-elevated`, `--shadow-2`), 300px, ≤70vh scroll. Top to
bottom: **sticky header** (gauge-mode switcher + the worst runs-out plan's
label + verdict — surfaces regardless of scroll or manual order) · provider
groups (severity-ordered, or manual pin order) · plan tiles · the one-line
switch hint · footer (age + refresh + gear → Settings § Usage). Tiles:
head (plan label · profile · status chip when non-operational · health
pill) → window rows (label · track · % · reset line) → verdict line. The
ACTIVE profile's tile speaks the rail's selection grammar: 4px `--accent`
left bar + `--accent-weak` wash, paint only. Compact density drops verdict
lines, keeps pills + bars.

### Severity inks (one mapping, everywhere)

| Signal | Ink |
|---|---|
| runs-out verdict / warn threshold toast / hot fill (≥90%) | `--warning` |
| on-pace verdict | neutral (`--text-mid` line, no tint) |
| surplus verdict / quiet toast / reset toast | quiet (`--text-mid`) |
| provider outage (chip, incident dot, relabeled reason) | `--danger` |
| degraded status chip | `--warning` |
| health `stale`/`error` pills | `--warning` ink on the pill |
| health `unconfigured` | `--text-mid` — a state, not an alarm |

Wording never varies by surface: the 7/02 verdict formatter and the 7/10
reset formatter are the only sources; popover, tab, toasts, and CLI render
their strings verbatim (smoke-asserted DOM === IPC === CLI).

### The Usage tab & confetti

Settings § Usage follows the settings row rhythm (`.settings-row` head +
control); the provider grid scrolls inside 420px with class group labels in
`section-label` ink; key controls are password inputs + masked
`--accent` "Key saved ····" chips. Reset confetti (opt-in) is 14 flecks in
`--accent`/`--warning`/`--danger`, ~1.1s fall anchored to the toast corner,
disabled entirely under `prefers-reduced-motion`.

## Audit ledger

Walked from `out/gallery/` (46 shots at the 5/01 audit; 93 shots incl. usage, 2026-07-06; **113 shots incl. the 8.5 revamp, 2026-07-09**). Shot refs use the
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
  - `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' src/ui/styles/global.css | awk -F: '$1 > 152'`
    → no color literals outside the token/theme-fallback blocks.
  - `grep -rn "@backend" src/ui --include='*.ts'` (and the inverse for `@ui`,
    `electron`, `node-pty`) → layer boundaries hold.
- **Tooltips owe CI no gate** (Phase-11.6, once built). The controller intercepts `title`
  globally, so a `title` added tomorrow is themed the first time it is hovered — there is no
  drift to police. This is the whole payoff of keeping `title` as the authoring API: the
  `data-tooltip` design we rejected would have owed this list a `grep -rn 'title[:=]'` gate
  forever, and a rule every contributor had to remember.
- The verification loop: `MOGGING_SHOT=all MOGGING_GALLERY=1` regenerates
  `out/gallery/` (113 shots, both themes) in one command; before/after pairs live in
  `docs/assets/gallery/`.
- Token changes re-run SMOKE + PERCEPTION + MILESTONE — restyle never renames the
  load-bearing selectors (`.workspace-tab[data-attention]`, `.pane-state[data-state]`,
  `.pane-git.has-git`, `.layout-slot[data-pane-id]`, …).
