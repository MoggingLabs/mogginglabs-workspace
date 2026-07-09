# Phase 8.5 — the UI/UX audit

Every user-facing surface, walked and graded before a single pixel moved. Steps
02–08 cite this file; a vague verdict here costs the whole pack, so every finding
carries a `file:line` and every REMOVE names its replacement.

**Method.** Static: every `.ts` render path + every CSS block cross-read against
the token ramp, plus a mechanical spacing grep (§ Enforcement). Dynamic: the
smoke suite is the compatibility surface — each surface's asserted selectors are
listed so a redesign can't silently break a gate. Grades are **density/spacing**
only: an `A` surface can still hold a bug (several do).

**The headline finding, and it is not what the brief assumed.** The complaint was
"no padding, no margins, no spacing scale." A scale *already exists* —
`--sp-1..6` (4/8/12/16/24/32), used **277 times**, with a documented off-ramp for
1–2px hairlines and 3px/6px optical half-steps in dense terminal chrome. Only
**33** spacing declarations sit off it (01 first reported 94 - an awk word-boundary
bug, corrected in 02; see § Enforcement). The real defects are three, and none of
them is "add a scale":

1. **No structural vocabulary.** There is not one `Card` in the app. `.settings-row`
   (`global.css:1846`) — a bare `flex column; gap: 8px`, no border, no background,
   no padding — is the *only* grouping primitive, and it is asked to hold a full
   CRUD manager (`settings/index.ts:189`). Sections and rows are visually identical.
2. **Rhythm inversion.** Separation *between* groups is routinely ≤ separation
   *within* them. Integrations puts **16px** between nine top-level sections
   (`global.css:3979`) and **8px** inside one (`:3871`). Home puts **4px** between
   bordered recents (`:1974`) and up to **44px** between columns (`:1957`).
   A 2:1 ratio cannot make nine sections read as nine sections.
3. **Wall-of-knobs.** Integrations renders **9** sections at once, Usage **7**, all
   expanded, each headed by a style-less `.settings-row-label` and followed by a
   200–450 character caption at **11px**.

Fixing the scale would have fixed nothing. Step 01 therefore ships the *missing*
piece — `Card` · `SectionHeader` · `FieldGroup` · `TwoColumn` — extends the ramp
to `--sp-7/8`, and adds the readable-column caps the app never had.

---

## Grades

**The pack's definition of done: every row below reads A.** Each non-`done` row now
names the step that owns it — the Verdict column is `fix|keep|keep+fix — <step>`.
`scripts/check-audit.mjs` (09) fails the sweep if any row is below A, or if any row
has a verdict with no owner. Grades are **density/hierarchy**; an `A` surface can
still hold a bug (see § Bugs, which routes all thirteen).

| Surface | Grade | Verdict | The one-line complaint |
|---|---|---|---|
| Wizard — shell/stepper | C → **A** | **done (02)** | Was: four structural joints all at 16px; two hairlines 12px apart above the footer. Now a full PAGE, no stepper, no modal |
| Wizard — Start | C− → **A** | **done (02)** | Was: three fields, three control heights (42/34/34px); a section heading sibling to form labels |
| Wizard — Layout | C → **A** | **done (02)** | Was: a live preview re-rendering what the selected tile already says. The caption says it now |
| **Wizard — Agents** | **F → A** | **done (02)** | Was: `padding: 5px`, 8 flat siblings, no cards, four control heights in one row |
| Home | C+ → **A** | **done (06)** | Was: bordered recents on a **4px** seam (rhythm-inversion). Now a Card grid on the token ramp; the four `clamp()` bypasses + the unseeable `3vh` are gone |
| First-run checklist | B− → **A** | **done (06)** | Chip + copy button hold one baseline now (the chip shrinks, not wraps); bug #1 fixed — REMOVE #21 deleted the immortal power-up row, so "Three steps" is true and the card self-dismisses |
| Settings — shell | C → **A** | **done (04)** | Was: no left/top padding, nav items `7px` tall-ish, no cards. Now TwoColumn + grouped nav + Cards; `7px` → `--sp-2`, the only shell spacing violation |
| Settings — Appearance / Terminal | B → **A** | **done (04)** | Cards + FieldGroups. Appearance still holds one control — a card's head is that control's label, so it is no longer a bare row |
| Settings — Profiles & hosts | D → **A** | **done (05b)** | 04 gave it the page frame; 05b made the five placeholder-as-label inputs real `FieldGroup`s and the two CRUD lists `Card`s with `SectionHeader` + `EmptyState` |
| Settings — Usage | D− → **A** | **done (05b)** | Was: 7 sections always open, 20 controls permanently expanded. Now an overview band + collapsible `Card`s, folded except overview and attention |
| **Settings — Integrations** | **F → A** | **done (05)** | 9 sections at once; `.mgr-chip` is a **1px-vertical-padding button** and the only click target for needs-auth/drift |
| Settings — Privacy / Browser | D → **A** | **done (04)** | ToggleRows with per-switch hints; every ADR clause kept, redistributed into a card caption + `.settings-scope` |
| Settings — Shortcuts | B → **A** | **done (08b)** | The `5px` row padding → `--sp-1`, the raw `0.08em` tracking → `--track-wide`, and the list is now a subgrid two-column table. One source (KB-01), CI-enforced |
| Settings — About | A | **done (01)** | Rebuilt on the four primitives |
| Board | D → **A** | **done (07)** | Cards are Cards with ONE aligned chip row (phantom flex items gone), lanes carry CountBadge counts, the ⋯ menu is fixed-positioned so the lane scroller can't clip it, and Delete gets a confirm |
| Palette | C− → **A** | **done (07)** | Rows on the rhythm (icon · title · hint · shortcut); empty query ranks top verbs by category (+ workspace context), a typed query highlights matches. Verb ids unchanged |
| Toasts / confirms / modal | C → **A** | **done (07b)** | One family: one radius, one stacking gap, one curve in AND out; `.btn--danger` now reads destructive (bug #6) |
| Review modal | D → **A** | **done (07b)** | Safe-first footer (Cancel before the danger merge), the merge de-emphasized from filled-primary to danger; the typed confirmation stays the guard |
| Titlebar | B → **A** | **done (08)** | Right cluster's order declared in ONE place (titlebar.ts); the `titlebarLeft` port lie corrected; darwin traffic-light inset tokenized (`--traffic-light-inset`). 26px hitboxes / 4px gaps kept |
| Workspace tabs | A− → **A** | **done (08)** | The one gap closed: scroll-edge fade at 8+ workspaces; `flex:none` makes "scroll, not shrink" true; bug #10 (collapsed collision) fixed. Identity ramp + attention latch kept |
| Pane headers | B+ → **A** | **done (08)** | `.pane-mcp` co-located + aligned to its siblings; bug #9 (overflow clip + `.pane-role` max-width/tooltip) and bug #12 (state dot leading) fixed. The 28px one-line design kept |
| Browser dock chrome | B / C → **A** | **done (08b)** | § Blockers #1 discharged: the possession label + consent + honesty spans get real, AA-safe rules (the label was 4.35:1 on nord), controls reach 28px, and DOCKUX gates it. REMOVE #13/#14 |
| Shortcuts overlay | B− → **A** | **done (08b)** | A two-column subgrid token grid from the single SHORTCUTS source; DOCKUX (d) asserts its row count equals Settings' |
| Update UX | A− → **A** | **done (06)** | REMOVE #15: the discarded `--pct` deleted; progress lives in the dot's `title` |
| Usage gauge (titlebar) | A | keep | All literals sanctioned dense chrome |
| Usage popover | D → **A** | **done (05b; recut 08c)** | 05b: real house tokens, theme-aware (bugs #4/#5). 08c: recut to the CodexBar dropdown — provider tabs → the selected provider's windows · pace · credits · cost · actions, on OUR IPC data (unbacked slots dropped, never faked). Gauge unchanged; USAGEGLANCE gates it |
| **Empty states** | **F → A** | **done (07b)** | The substantial surfaces route through `EmptyState` (the empty board lane — the worst — now speaks, and gives `action` its first caller); inline dropdown notes stay inline by design |

---

## Findings by surface

### Wizard (`src/ui/features/wizard/index.ts`, 944 lines)

- `.wizard-agent-row { padding: 5px var(--sp-2) }` — `global.css:2204`. `5px` is on no ramp and in no off-ramp. The primary offender.
- Four control heights inside one `align-items:center` row: `.stepper-btn` 24px (`:501`), `.wizard-profile-select` 28px (`:3455`), `.wizard-agent-copy` ~22px (`:4282`), `Pill` (`:398`). Row height is set by whichever optional control happens to render.
- `.wizard-agents { gap: 2px }` (`:2198`) between hoverable rows — a hairline doing list rhythm.
- Agents step is **8 flat siblings** at a uniform 16px (`:2076`, `wizard/index.ts:855-879`). No cards. Section headers exist only inside `.wizard-agent-footer`.
- The meter groups **upward**: `.wizard-fill-row` is separated from its "Quick fill:" controls by the same 16px that separates it from the modal subtitle.
- Start's three fields have three control heights: `.path-input` 42px (`:2332`) vs `.input` 34px (`:470`) ×2.
- Double divider above the footer: `.wizard-footer::before` (`:2085`) hairline **plus** `.modal-footer { border-top }` (`:2621`), 12px apart. Identical defect on `.review-footer`.
- Layout step's `.wizard-layout-preview` re-renders the miniature + "4 terminals · 2×2 grid" that `.layout-tile.is-selected` + its `aria-label` already carry.
- Dashed borders on `.wizard-layout-preview` (`:2156`) and `.wizard-isolate` (`:2300`) — dashed reads as *drop target*; both are static containers.

**Advanced → collapse in 02:** "Runs on" remote select (one option for most users), per-slot profile picker, swarm preset, tool-plan picker, worktree isolation, custom command, preset save/delete.

### Home + first-run (`src/ui/features/home/`)

- **Rhythm inversion:** `.home-list { gap: 4px }` (`:1974`) between 1px-bordered surfaces, while `.home-sections { gap: clamp(16px,2.6vw,44px) }` (`:1957`). The 4px seam reads as an artifact.
- Spacing `clamp()`s bypass the ramp with upper bounds on no step: `20px` (`:1921`), `10px` (`:1943`), `36px` (`:1952`), `44px` (`:1957`), plus `margin-top: 3vh` (`:1912`). **Sizing** clamps (`.home-logo` w/h, `.home-title` font) are justified fluid behavior — **keep**.
- Recents and presets use the identical `.home-item` treatment — visually indistinguishable.
- Checklist structure is **sound** (one `<section>` card, per-row `check-circle`/`clock`). Two defects: the `<code>` install chip has `padding: 1px 6px` (`:4265`) beside a `3px`-padded copy button (`:4282`), and `.firstrun-cli-missing { flex-wrap: wrap }` (`:4251`) with no `flex` on the chip → **the copy button wraps below the command on any realistic install line**.
- `firstrun.ts:81` renders the Copy button with `icon('folder')`. There is no `copy` glyph in `components/icons.ts`.

### Settings (`src/ui/features/settings/`, 2510 lines across 4 files)

- `.settings-row` (`:1846`) is the only grouping primitive: no border, no background, no padding. It wraps the entire profiles+hosts CRUD manager (`settings/index.ts:189`) as the *control* of a `row()` whose label is "Pointer sets only".
- **Integrations renders 9 sections at once** (`integrations.ts:1154-1164`), **Usage 7** (`usage.ts:510-518`). Captions run 250–450 characters at `--fs-11` inside `max-width: 52ch`.
- `.mgr-chip { padding: 1px var(--sp-2) }` (`:4022`) — a **1px vertical padding button**, ~16px tall, and the only click target for `needs-auth` and drift repair.
- `.trail-btn { padding: 2px var(--sp-2) }` (`:3894`) — ~18px tall, and it is the button primitive for Preview, Connect, Import, Apply, Remove, Adopt, Forget, Save, Clear trail, Authorize.
- **Three nested scrollers** inside `.settings-content { overflow-y:auto }`: `.usage-grid { max-height:420px }` (`:4480`), `.trail-list { max-height:360px }` (`:3914`), `.mgr-panel-block { max-height:200px }` (`:4082`). `showSection()` resets the outer scrollTop, never these.
- Two measures for the same prose class: `.settings-row-caption { max-width: 52ch }` (`:1860`) vs `.trail-honesty { max-width: 72ch }` (`:3972`). **Resolved by `--measure` (68ch) in this step.**
- Radio labels carry whole trade-off sentences (`integrations.ts:97-104`); a bridge caption embeds a literal JSON schema in running prose (`:1027`).
- Ship copy leaks build phases: "a tool plan (8/09)", "8/08" (`integrations.ts:119`).

**Attention states that MUST survive collapse in 05:** `.mgr-chip.is-needs-auth` / `.is-drift-*`, `.toolplan-truth` pending-restart count, `.evbridge-health.is-failing`, `.trail-badge.is-refused`, `.cat-badge.is-draft`, `.usage-health.is-error`, `.usage-fill.is-hot`.

### Board / palette / feedback

- `board/index.ts:291` — `[cardStateChip(card) ?? el('span',{}), approvedChip(card), serviceLinkChip(card) ?? el('span',{})]`. `el()` **already drops nulls** (`dom.ts:64`), so each `?? el('span',{})` creates a real zero-width flex item consuming an 8px gap. With `.board-card-foot { min-height:16px }` (`:3434`), a bare To-do card spends **29% of its height on a blank strip**.
- `.board-card-foot` has **no `flex-wrap`**. Three chips (~315px) overflow a ~290px card. `.board-lane-cards { overflow-y:auto }` (`:3379`) leaves `overflow-x` computing to `auto` → a horizontal scrollbar per lane.
- `.board-card-menu { position:absolute; z-index:30 }` (`:3458`) lives inside that scroller → **the ⋯ menu is clipped on the last card of any lane**, and its length is unbounded (one row per installed agent).
- The **worktree branch is parsed and thrown away** (`board/index.ts:235`) — the card never shows it.
- Board and rail speak different languages for one concept: rail = `.pane-state` dots, board = labeled chips.
- **Five chip systems**, four paddings (`1px 7px`, `1px 8px`, `2px 10px`, `0 6px`), three spellings of one 999px radius. `Pill()` has exactly **one** call site app-wide.
- Feedback family diverges on every axis: radius (toast 10px vs modal 14px), width (380/460/520/560/720/880 — four of them inline), exit motion (only the toast animates out; its `260ms` is a magic number, not `--dur-2`), backdrop (modal fades, palette snaps), `.toast-dismiss` 20px vs `.icon-btn` 26px.
- **`.btn--danger` is transparent ghost text** (`:353`), typographically identical to the Cancel ghost. There is no high-emphasis destructive treatment in the app, while a benign "Link" gets the filled accent (`board/index.ts:117`). The loudest button in the app is a save; the irreversible one is the quietest.
- Palette empty-query = `allCommands().slice(0,12)` in feature-mount order (`palette/index.ts:82-87`; all scores are `1`, the sort is a no-op). No rank, no sections, no match highlighting — the scorer computes match offsets at `:16-21` and discards them. No `aria-activedescendant`; no focus restore on close.

### Chrome

- `#app.platform-darwin #titlebar .brand { padding-left: 84px }` (`:983`) is a **correct** traffic-light inset (`main/window.ts:24` sets `x:14`; three 12px lights at 8px pitch → 66px + 18px air). But it is a magic literal duplicated from a main-process constant, while the *Windows* side of the same problem got `--controls-reserve`. **Keep the value, fix the coupling.**
- `feature-registry.ts:7` documents `titlebarLeft` as "after the brand". `titlebar.ts:86` appends both slots **inside `.titlebar-right`**. `workspace/index.ts:181` mounts the layout picker there believing otherwise. Right-cluster order is feature-registration order, declared nowhere.
- **There is no MCP chip in the titlebar** — the brief assumed one. The only MCP surface is per-pane (`.pane-mcp`).
- Workspace tabs: `overflow-y:auto`, tabs `flex:none` → **scroll, not shrink. Correct.** But no scroll-edge fade, unlike `.ws-label`'s mask. In collapsed rail the agent-browsing dot (`:1127`) collides with `.ws-attn` (`:1158`).
- Pane headers: fixed 28px, chips `flex:none`, title ellipsises — **correct by design**, and their 3px/6px are sanctioned. Two real defects: `.pane-head-left` has no `overflow`, so with all four chips lit in a narrow pane they overflow into the centre branch chip; and `.pane-role` has no `max-width` and no tooltip.
- `.pane-mcp` (`:2868`) breaks its three siblings on **every** axis — `--fs-11` vs `--fs-10`, `6px` vs `--sp-1`, `--r-full` vs `3px`, and an **unset `line-height`** so it resolves a different height inside a 28px bar. It also lives ~1300 lines away from them.
- Chrome ships **3px, 4px, 5px and 6px radii** with no token behind three of them.
- Four hand-tuned popover anchors: `top: 24px` (`:1653`), `32px` (`:1366`), `64px` ×2 (`:3815`, `:3922`).
- **The possession surface — the pack's most consequential finding.** `.browser-agent-label`, `.browser-confirm-text`, `.browser-agentweb-note-text` are created (`browser/index.ts:83,109,99`) and have **no CSS rule anywhere**. And **no smoke asserts any `.browser-*` class** — every browser smoke routes through main-process helpers (`dockDebug`, `agentControlDebug`, …), never rendered DOM. The one surface the pack forbids dimming has zero styling contract and zero DOM coverage. See § Blockers.

### Empty states — the work item

**2 of 26** "nothing here" surfaces route through the house `EmptyState`; both are in Home (`home/index.ts:120, 178`). The rest are hand-rolled across six classes (`.ph-empty`, `.menu-note`, `.menu-empty`, `.browser-empty`, `.palette-empty`, `.review-note`, `.trail-empty`, …).

Worst: **a board lane has no empty state at all** — `board/index.ts:355` renders `inLane.map(cardEl)` into a silent empty `<div>`. `.browser-empty` (`:3585`) is a hand-rolled clone of `EmptyState`. `EmptyState` supports `action?: Node` — **no caller uses it**, including `integrations.ts:459`, which hand-rolls a CTA it could have passed.

---

## The REMOVE list

Every entry names its replacement. Executed by the step that owns the surface.

Status: **✅ = executed**. 02 cleared every wizard row; 05 cleared every integrations row.

| # | Item | Location | Replacement | Step |
|---|---|---|---|---|
| ✅ 1 | palette verb `wizard:open` | `wizard/index.ts:112-114` | `workspace:new` (`workspace/index.ts:305`) — byte-identical title+hint, **plus** a `Ctrl+T` chip and a no-wizard fallback. Two indistinguishable rows today. Keep `setWizardOpener(open)` at `:111` — that is the port. | 02 ✅ |
| ✅ 2 | palette verb `integrations:connect` | `settings/index.ts:391` | `integrations:open` (`:389`) — both call `goIntegrations('servers')`. Safe: `integux-smoke.ts:65` needs ≥2 matches; **4 remain**, each carrying the hint `Integrations`. (The old "5 remain" counted against a selector half of which — `.palette-result` — matched nothing: bug #13, fixed first.) | 05 |
| ✅ 3 | palette verb `integrations:restart` | `settings/index.ts:393` | `integrations:matrix` (`:390`). Its title promises "Restart panes to pick up new tools"; the `run()` **scrolls the matrix into view and restarts nothing**. A lying verb. | 05 |
| ✅ 4 | `.wizard-layout-preview` + `.wizard-layout-caption` + `renderPreview()` | `wizard/index.ts:467-478,488`; `global.css:2151-2167` | `.layout-tile.is-selected` (`:2471`) + `.layout-tile-count` + the tile's `aria-label` already carry count and shape. | 02 ✅ |
| ✅ 5 | `.wizard-footer::before` / `.review-footer::before` | `global.css` | `.modal-footer { border-top }` already marks the fold; both halves of the double divider gone. | 02 ✅ / 07b ✅ |
| ✅ 6 | Duplicate `Set up integrations…` CTA in `.integux-empty` | `integrations.ts:457-459` | The `.integux-intro` CTA (`:1129`). Two identical primary buttons ~400px apart. Safe: `integux-smoke.ts:57` asserts only that `.integux-empty` exists. | 05 |
| ✅ 7 | `.board-lane-count` | `board/index.ts` | `CountBadge()` — brings `tabular-nums`, so the count stops jittering as cards drag; the old `.board-lane-count` rule is gone. | 07 |
| ✅ 8 | `CountBadge` / `TextInput` / `mount` exports | `pill.ts`, `input.ts`, `dom.ts` | `CountBadge` adopted (#7 — now live, generalized with a `label`); `TextInput` + `mount` deleted (zero call sites). | 07 |
| ✅ 9 | `.pill--success` / `--danger` | `global.css` | Removed (dead). **`.pill--accent` KEPT** — `folder-browser.ts:185` renders `Pill({ tone:'accent' })`, so the "one call site" note was stale. | 07b |
| ✅ 10 | `.settings-footer` | `global.css:2070-2075` (cited line was stale) | Dead — vestige of Settings-as-a-modal; Phase-5/05 made it a full page with a left nav + Back. Deleted with `.settings-about`, `.settings-about-name` and a bare `.settings` rule, all equally orphaned. | 04 ✅ |
| ✅ 11 | `.pane-badge` CSS block (keep the class) | `global.css:1741-1746` | Duplicates `.pane-head-left`; its `flex:none` is **inert** (the element is a grid item). Its comment — and `terminal-pane.ts:352` — claim it is "the DOM contract of the launch/milestone smokes". **Grep: zero smokes reference `.pane-badge`.** Fix the comments too. | 08 |
| ✅ 12 | `#app.rail-collapsed .workspace-tab:hover .ws-count` | `global.css:1163-1165` | Dead — `.ws-count` is already `display:none` in collapsed rail (`:1144`). | 08 |
| ✅ 13 | `.browser-ws-chip:hover {}` (empty ruleset) | `global.css` | The ws-chip now carries the `.browser-agentweb-sites:hover` treatment (accent border + `--accent-ink`) — no empty ruleset remains; it is no longer the one dock button without hover feedback. | 08b ✅ |
| ✅ 14 | `trailBtn.classList.remove('is-hidden')` | `browser/index.ts` | Deleted — `is-hidden` was never added and had no rule. | 08b ✅ |
| ✅ 15 | `--pct` on the update dot | `updates/index.ts` | Deleted — nothing read it; progress survives in the `title`, the dot stays a quiet pulse. | 06 |
| ✅ 16 | `.layout-menu-tile` + the ad-hoc titlebar tile builder | `global.css:1377-1390`; `workspace/index.ts:196-206` | `createLayoutGridPicker()` (`grid-preview.ts:61`) with a `compact` variant. Today `.layout-menu-tile .layout-tile-count` **reaches across to override the other component's class**. | 08 |
| ✅ 17 | `EmptyState` import; `templates.resolve`/`templates.list` dev handles; `el('div',{})`/`el('span',{})` spacers ×3; `.wizard-preset-wrap` dup block | `wizard/index.ts:6, 448, 452, 687, 898-899`; `global.css:2247` | Dead, none needed. | 02 ✅ |
| ✅ 18 | `?? el('span', {})` ×2 | `board/index.ts` | Deleted — `el()` drops nulls; `.board-card-foot { min-height:16px }` dropped with them. | 07 |
| ✅ 19 | `buildMenu(menu, _titleEl)` unused param | `terminal-pane.ts:593` | Dead. | 08 |
| ✅ 20 | `.usage-history-block` class; cadence `<select>` on **disabled** providers; the `Test notification` button | `usage.ts` | Class + its `.usage-history-block-row` name-collision both gone with the block→Card restructure. Cadence renders only when enabled. `Test notification` now behind `import.meta.env.DEV`. | 05b |
| ✅ 21 | Checklist row 4 "Optional: add a profile, SSH host, or board card" | `firstrun.ts` | Deleted — no action button, a 3-way OR, and (bug #1) **missing `optional:true`** so it blocked the card from ever self-dismissing. Gone; "Three steps" is true again. | 06 |

**Stale copy to correct** (same steps): `firstrun.ts:71,27` "Three steps" → four rows · `layout/templates.ts:18` "Offered in the layout toolbar" → no toolbar exists · `core/commands/shortcuts.ts:3-6` claims the palette reads from `SHORTCUTS` — **it does not**; every palette `kbd:` is a hardcoded string · `settings/index.ts:39-40` lists 8 tabs, there are 9 (Shortcuts missing) · `wizard/index.ts:67` claims `openCwd` was absorbed — it is **live** (`deep-link.ts:94`) · `board/index.ts:348` "▸ start an agent on it" — no `▸` control exists · `confirm.ts:9-10` asserts the destructive button "is danger-styled" — it is ghost text · `review/index.ts:172` renders literal backticks · `features/workspace/README.md` names a layout toolbar, a theme picker, and a `themes.ts` that does not exist there.

**Explicitly KEEP despite looking removable:** the titlebar layout popover (`workspace/index.ts:167-209`) — it re-grids a **live** workspace; the wizard picker sets the grid at **creation**. Different jobs. · `openCwd` (backs `mogging .`) · `ProviderMixTemplate` (backs the wizard *and* Home presets) · `grid-layout.ts:269 toggleZoom` ("legacy alias" is a misnomer; it is the live zoom API) · the 7 legacy CSS vars (`global.css:124`) — a sanctioned, in-progress migration shim; removing them needs its own pass.

**RESOLVED — removed (07b):** `resetConfirmSkipsForSmoke` had zero callers anywhere — no smoke, no `window.__mogging` handle, no ES string. `git show a74a68d` touches `perception-smoke` / `perwsagent-smoke`; its "confirm race" was the browser-dock act-origin approval (`confirmPendingActOrigin`), a different mechanism entirely. Deleted the function + its barrel re-export.

---

## Bugs found — every one routed (8.5/04 audit-of-the-audit)

01 recorded these and moved on. **Twelve of the thirteen named no owner**, and the
Grades/REMOVE tables both have owner columns while this list had none — the single
largest coverage hole in the file. Each now names its step. `check-audit.mjs` (09)
fails if any entry loses its owner or its ✅.

| # | Bug | Owner | Status |
|---|---|---|---|
| 1 | first-run card can never self-dismiss (`optional:true` omitted; `product-smoke` masked it) | **06** | **✅ fixed in 06** |
| 2 | `review-smoke.ts:115` removes `<body>` | **07b** | **✅ fixed in 07b** |
| 3 | `swarmBtn` double-renders the Agents screen | **02** | **✅ fixed in 02** |
| 4 | nine usages of tokens that do not exist (`--surface-1/3`, `--text-dim`, `--border-1`) | **05b** | **✅ fixed in 05b** |
| 5 | `.usage-tile.is-active::before` uses a RADIUS token as a vertical inset | **05b** | **✅ fixed in 05b** |
| 6 | `.btn--danger` carries no emphasis | **07b** | **✅ fixed in 07b** |
| 7 | `Delete card` is irreversible with no confirm | **07** | **✅ fixed in 07** |
| 8 | the app's most destructive confirm is opt-out-able (`rememberKey`) | **07b** | **✅ fixed in 07b** |
| 9 | `.pane-head-left` chip cluster overflows into the branch chip | **08** | **✅ fixed in 08** |
| 10 | collapsed-rail collision (agent dot over `.ws-attn`) | **08** | **✅ fixed in 08** |
| 11 | grid-layout button offered on Home / Board / Settings | **08** | **✅ fixed in 08** |
| 12 | remote pane: state dot is no longer the leading glyph | **08** | **✅ fixed in 08** |
| 13 | `integux-smoke.ts:65` asserts `.palette-result`, a class that exists nowhere | **05** | **✅ fixed in 05** |
| 14 | `.trail-btn.is-armed` has no CSS rule — the **write-tools grant toggle has no on-state** | **05** | **✅ fixed in 05** |
| 15 | the workspace list is read once at boot, so **Workspace tools and Grants render permanently blank** | **05** | **✅ fixed in 05** |
| 16 | the catalog's "in N of M workspaces" coverage and its imported presets never repaint — both go stale on any plan edit | **05** | **✅ fixed in 05** |

> **Cross-check neither entry made.** Bug #13 says half of `integux-smoke.ts:65` is
> dead — and REMOVE #2's safety argument ("≥2 matches; 5 remain") *rests on that very
> assertion*. 05 therefore fixed the gate **before** removing the verb. Four
> `integrations:*` verbs survive, each carrying the hint `Integrations`, so the real
> assertion (`.palette-item`, count ≥ 2) still has headroom.
>
> **Bugs #14 and #15 were found DURING 05, not by 01.** Neither was in the audit.
>
> **#14** is the more serious. `.is-armed` was styled only as `.trail-clear.is-armed`.
> Two buttons carry `is-armed` *without* that class — "Write tools: ALL (agents can
> send/mail/claim/update here)" and "Inherit global tools" — so the toggle that decides
> whether agents may write in a workspace looked **identical on and off**. The sole
> signal was the word ALL inside its own label. A permission whose enabled state is
> indistinguishable from its disabled state is not a control. (The fix is scoped
> `:not(.trail-clear)`: armed-Clear is *danger*, armed-grant is *warning*, and an
> unscoped rule — later, equally specific — would have repainted armed-Clear.)
>
> **#15** was found by 05's own smoke, not by reading. `refreshWorkspaces()` runs once,
> in the `setTimeout(…, 0)` that follows each block's build — and the Settings page is
> constructed at BOOT, before any workspace exists. So `wsSelect.value` stayed `''`,
> `render()` hit `if (!wsId) return`, and **"Workspace tools" and "Grants" rendered
> blank for the whole session**: no matrix, no dropdown, not even the empty-state
> sentence that explains what a plan is. The event bridge never repopulated its scope
> select at all. Every block that depends on the workspace list now re-reads it on
> entry into Settings (`SyncedBlock`).
>
> **#16 fell out of #15's fix, and only because the smoke tried to prove #14's cousin.**
> To raise `.cat-badge.is-draft` the smoke imports a community preset — and the badge
> never appeared. The catalog is workspace-dependent too, by exactly #15's test: every
> card renders "in N of M workspaces" from `planCoverage`, and its `custom` presets live
> in main's KV, which the guided-flow modal also writes. Neither repainted. Edit a tool
> plan, return to the catalog, and the coverage counts still show the old numbers.
>
> **And a second half-dead assertion, of bug #13's family.** `integux-smoke.ts`
> computed `matrixEmptyOk`, reported it, and left it OUT of `pass`. It has been `false`
> every run for four phases — the direct symptom of #15 — and nothing noticed. It now
> counts toward the verdict.
>
> The pattern across #13, #15/#16 and `matrixEmptyOk` is one thing: **a check that
> cannot fail teaches you nothing.** A selector that matches nothing, a value computed
> and discarded, a fixture that never creates the state it asserts. SETINTEG seeds the
> failing webhook and imports the community preset rather than hoping a stock fixture
> happens to contain them.

The original entries, verbatim:


1. **The first-run card can never self-dismiss.** `firstrun.ts:176` omits `optional:true` while its title says "Optional:". The gate is `rows.every(r => r.done || r.optional)` (`:202`). `product-smoke.ts:100-102` masks it by saving two profiles before asserting collapse. → REMOVE #21.
2. **`review-smoke.ts:115` removes `<body>`.** `review/index.ts:108` adds `.review-modal` to `modal.el`, which `modal.ts:102` returns as the **overlay**; `m.parentElement.remove()` therefore targets `document.body`. Latent — nothing after it touches the DOM.
3. **`swarmBtn` double-renders the Agents screen.** `wizard/index.ts:818` calls `renderAgents()` directly; `clear(body)`/`clear(footer)` live only in `render()` (`:299`). Clicking "Swarm preset" appends a second complete copy of the screen.
4. **Nine usages of tokens that do not exist:** `--surface-1`, `--surface-3`, `--text-dim`, `--border-1` (`global.css:4344,4364,4377,4392,4803,4831,4839,4843`, `:4493`, `:4583`). Each falls through to a hardcoded gray. **The usage gauge track and popover foot border do not participate in the theme.**
5. **`.usage-tile.is-active::before` uses `var(--r-md)` — a *radius* token — as a vertical inset** (`:4687`), and its `6px` fallback is a lie (`--r-md` is 10px). Same lie in four `var(--r-md, 6px)` call sites.
6. **`.btn--danger` carries no emphasis** (`:353`) — see Board/feedback above.
7. **`Delete card` is irreversible with no confirm** (`board/index.ts:328`), contradicting `confirm.ts:6-11` ("wire the confirm", not "remember to").
8. **The most destructive confirm in the app is opt-out-able:** closing a workspace with a live agent passes `rememberKey: 'workspace.close'` (`workspace/controller.ts:454`).
9. **`.pane-head-left` chip cluster can overflow into the centre branch chip** in a narrow pane with remote+role+claims+mcp lit.
10. **Collapsed-rail collision:** agent-browsing dot (`:1127`) over `.ws-attn` (`:1158`) — two "look here" signals on the same 8px.
11. **The grid-layout titlebar button is offered on Home, Board and Settings**, where no grid exists; clicking it calls `applyTemplate()` against the hidden active workspace. No view-scoped hide rule exists.
12. **On a remote pane the state dot is no longer the leading glyph** — `terminal-pane.ts:391` appends `remoteChip` before the ordered `append` at `:424`, contradicting both its own doc comment and `global.css:1574`.
13. **`integux-smoke.ts:65` asserts `.palette-result`**, a class that exists nowhere in `src/`. The assertion passes on `.palette-item` alone; the second half is dead.

---

## § Blockers — resolve before any restyle lands

**The possession/consent surface has no styling contract and no DOM coverage.**
`.browser-agent-label`, `.browser-confirm-text` and `.browser-agentweb-note-text`
are unstyled spans inheriting `--fs-11`. **No smoke asserts any `.browser-*`
class** — every browser smoke drives main-process state (`dockDebug`,
`agentControlDebug`, `agentPossessionDebug`, …) and never reads rendered DOM. The
nearest coverage is the rail mirror `.workspace-tab[…].is-agent-browsing`
(`perwsagent-smoke.ts:111`).

The pack's guardrail says these surfaces "may be restyled, never dimmed." Today
nothing — not a token, not a rule, not a gate — would object.

> **Blocker 1 — DISCHARGED (08b).** The DOCKUX guard was written against today's DOM and
> watched pass BEFORE any restyle: while `driving === true`, `.browser-dock` carries
> `agent-driving`, `.browser-agent-banner` is shown, `.browser-agent-stop` is
> hit-testable, and `.browser-agent-label` is non-empty at `font-size >= 11px`, opaque,
> AA against its real composited background. The guard immediately caught a real defect —
> the label was **4.35:1 on nord** — which the restyle fixed (it is `--text-hi` now; worst
> 7.93:1). The three spans now carry rules of their own (DOCKUX (c)), and the possession
> chrome is present only while driving (DOCKUX (b)). Written before the restyle, green after.

**Blocker 2 — DISCHARGED (07b).** `.review-gate-open` / `.review-gate-closed` — the
reviewer sign-off indicator, the whole point of the 4/03 gate — now carry a distinct
icon AND word (not colour alone), with AA-safe ink; FEEDBACKUX (d) asserts both states
render distinguishably. It was previously uncovered (`gate-smoke.ts` / `integ-smoke.ts`
assert zero DOM selectors).

---

## § Patterns — the 21st.dev research

**Honesty first.** 21st.dev's category pages render server-side (URLs verified,
HTTP 200), but component detail pages are client-rendered React — the code and
class names are not fetchable. **No spacing number below was read off 21st.dev.**
Every value comes from the upstream source 21st.dev skins (mostly shadcn/ui's
registry on GitHub), fetched and read directly. Verified 21st.dev URLs:
`/community/components/s/card`, `/s/form`, `/s/empty-state`, `/s/file-tree`,
`/s/modal-dialog`, `/s/toast`, `/s/command-palette`.

**Zero code imported. Layout ideas and spacing rhythms only.**

| Surface | Pattern → informed | Rhythm (upstream) | Ports to vanilla? |
|---|---|---|---|
| **Card** | shadcn `Card` → our `Card` | root `py-6 gap-6` (24px), slots `px-6`; header `gap-2` (8px) title→description | **YES.** Note shadcn is *migrating toward* a `--card-spacing` custom property — i.e. toward the architecture we already have. |
| **Section header** | shadcn `CardHeader`/`CardAction` → our `SectionHeader` | 8px title→caption; action grid-positioned | **YES — the highest-value steal.** Grid + `:has()`, not flex. The action spans both rows and pins top-right, so a two-line caption never vertically re-centers the button. Flexbox `space-between` gets this wrong. **Adopted verbatim as a layout idea** (`global.css .section-header:has(> .section-header-action)`). |
| **Field group** | shadcn `Field` → our `FieldGroup` | `gap-3` (12px) label→control **and** control→hint; `FieldContent gap-1.5` (6px) for the tight title/description pair | **YES.** We diverge deliberately: hint sits under the **label** (the house `.settings-row` pattern), 8px label→control, 4px label→hint. shadcn's `gap-7` (28px) between fields is off every scale including its own — ignored. **Stolen verbatim:** `role="group"`, `role="alert"` on the error, `aria-describedby` + `aria-invalid` wiring. |
| **Settings page** | shadcn `Sidebar` + `Accordion`; Geist `design.md` | sidebar 256px; group label 32px; **4px between nav items, 8px between groups**; accordion trigger `py-4` | **PARTLY.** Two-column + group labels: trivially ours. Radix's accordion needs a ResizeObserver for `--radix-accordion-content-height`; **we skip it** — `grid-template-rows: 0fr→1fr` is Chromium-native here. Steal `<nav>` + `aria-current="page"`. **Do NOT make settings nav a `tablist`.** |
| **Stepper vs one page** | Ark UI Steps; NN/g; GOV.UK | — | **This settles step 02.** There is **no WAI-ARIA APG pattern for a stepper**; the defensible markup is `<ol>` + `aria-current="step"`. NN/g says avoid wizards for *repetitive tasks*, *expert users* ("resent the controlled flow"), and *arbitrary-order* completion. GOV.UK's "one thing per page" wins are for *low-confidence users*, *mobile*, and *branching/save-and-resume* — and its evidence is qualitative lab testing, not A/B data. **Our case is a desktop config surface, used repeatedly, by one person, no mobile, no branching. All three NN/g "avoid" conditions apply; none of GOV.UK's three benefits do.** One page is correct, and now we can say why rather than assert taste. |
| **Folder browser** | WAI-ARIA APG Tree View; shadcn `Breadcrumb`/`Item` | breadcrumb `gap-1.5` (6px); row `gap-2.5 px-4 py-3` (10/16/12px); `ItemContent gap-1` (4px) | **PARTLY — budget it as a component, not an afternoon.** Breadcrumb + rows: yes. Full APG tree (roving tabindex, type-ahead, `aria-level`/`setsize`/`posinset` on a lazily-loaded tree) is several hundred lines. **Use roving tabindex** — APG's own tiebreaker is that the user agent scrolls the focused node into view. |
| **Toasts** | Sonner; Radix Toast | `VIEWPORT_OFFSET 24px`, `GAP 14`, `WIDTH 356` — **14 and 356 are off-grid; use 16 and 360** | **PARTLY.** Live region + stack: yes. **Do NOT** reimplement swipe-to-dismiss, the height-recalculating stack, or expand-on-hover — that *is* Sonner. Steal Radix's foreground/background split (`role="alert"` vs `role="status"`) and the **F8 hotkey to focus the toast viewport** — it is how keyboard users reach a toast action at all. |
| **Confirm dialog** | shadcn `AlertDialog`; MDN `<dialog>` | content `p-6 gap-4` (24/16px); footer `gap-2`; `sm:max-w-lg` (512px) | **YES — cheaper for us than for React.** `dialog.showModal()` gives focus trap, top layer, `inert` on the rest, `::backdrop`, Esc-to-close and `aria-modal` **natively**. Radix exists to polyfill this. Put `autofocus` on **Cancel**. Do not put `tabindex` on `<dialog>`. |
| **Empty state** | shadcn `Empty`; Geist copy rule | `gap-6 p-6→p-12`; header `max-w-sm` (**384px**) | **YES.** The 384px cap is the point: empty-state prose is capped *narrower* than body text so it reads as a message, not a paragraph. Copy rule: point to the first action. |
| **Command palette** | cmdk; shadcn `Command` | input `h-9` standalone / `h-12` in dialog; items `px-2 py-1.5` | **PARTLY.** The ARIA shell (~150 lines) is worth writing: `role="combobox"` + `aria-activedescendant`, list `role="listbox"`, items `role="option"`. **Do NOT** reimplement cmdk's fuzzy scoring / auto re-ranking / `keywords` aliasing. |

**The deliberate inversion worth remembering:** the file tree uses **roving
tabindex** (so focus scrolls into view); the command palette uses
**`aria-activedescendant`** (so DOM focus never leaves the input and typing keeps
working). Same problem, two answers, for good reasons. Getting them backwards is
the single most common way these two components go wrong.

**Four things cheaper for us than for React, because Electron pins Chromium 132:**
native `<dialog>.showModal()`; `:has()`; accordion height via
`grid-template-rows: 0fr→1fr` (no ResizeObserver); `@container` + `text-wrap: balance`.
*(Verify `closedby` before relying on it; without it `showModal()` still gives Esc-to-close.)*

**Do NOT attempt in vanilla**, ranked by pain-per-value: cmdk's ranking engine ·
Sonner's swipe/stack/expand · a fully APG-conformant lazily-loaded tree
(underestimated) · anything from Aceternity/Magic UI (framer-motion — and it
would bring the runtime dep we've excluded) · Radix/Ark stepper state machines
(we're building one page anyway).

**The convention answers.** Readable settings column **600–720px**
(Butterick: 45–90 chars; at ~7px advance, 90 chars ≈ 630px). Card padding **24px**,
gap between cards **16px** — *keep gap ≤ padding* or cards stop reading as a group.
Label→control **8px**, control→hint **6–8px**. Section rhythm: Geist states the
whole ladder in one line — **"8px inside a group, 16px between groups, 32–40px
between sections."** Our 4/8/12/16/24/32/48/64 ramp is compatible; Geist adds 40
and 96, omits 48.

---

## § Enforcement — the drift grep

The rule is mechanical so the milestone can gate on it without judging context:

> **No spacing declaration may carry a px literal outside the sanctioned set
> {0, 1px, 2px, 3px, 6px}.** 1–2px are hairlines/seams; 3px/6px are optical
> half-steps licensed *only* inside dense terminal chrome (pane-header clusters,
> chips, icon tiles, kbd hints). Everything else takes a `--sp-*` stop.
> A wizard, a settings page, Home, and the board are **not** dense terminal chrome.

```sh
node scripts/check-spacing.mjs            # count + per-bucket breakdown
node scripts/check-spacing.mjs --list     # every violation with file:line, bucketed
node scripts/check-spacing.mjs --max 7    # today's ceiling; 09 freezes it at --max 0
```

> **Correction, made in 8.5/02.** 01 shipped this rule as an `awk` one-liner using
> `\b`, and reported **94** violations. Git Bash's `awk` is **mawk, which silently
> ignores `\b`** — so its `gsub` stripped nothing and it counted almost every px
> line. The true number was **33**. Numbers you cannot reproduce are worse than no
> numbers, so the rule now ships as `scripts/check-spacing.mjs` (node, no deps),
> which is what step 09 gates on. The buckets below are the corrected ones.

**Baseline at the close of 01: 33 violations.** After 02: **28** (the wizard bucket
is clear). After 04: **27**. Existing violations are *listed, not mass-fixed*; each
step burns down its own surface. The number must **never rise**, and 09 gates on
`--max 0`.

> **Correction (8.5/04 audit-of-the-audit).** This section said the four `clamp()`
> spacing bypasses "the px checker cannot see". It sees them: `clamp(16px, 2.4vh,
> 36px)` contains px literals, and those four **are** the entire `home` bucket. What
> the checker genuinely cannot see is any **non-px** unit. 06 removed `.home-hero`'s `3vh`
> and 07 removed `.palette-overlay`'s `12vh` (both → `--sp-*`), so **no non-px spacing
> bypass remains** — `--max 0` now certifies the whole surface, not all-but-two.
> Note also that
> `.home-logo`'s *sizing* clamps (w/h/radius) are **keep**; only its `margin-bottom`
> clamp is a fix — the old text conflated them.

The old "04 + 05" row hid the split. The `settings` bucket's 7 was **1 shell** +
**6 mega-tab**: only `.settings-nav-item { padding: 7px }` belonged to the shell.
The `—` row is `.segmented-item`; it is now 07b's.

| Owner | Script bucket | Remaining selectors | At 01 | Now | Target |
|---|---|---|---|---|---|
| **02** | `wizard` | — | 5 | **0 ✓** | 0 |
| **04** | `settings` (shell) | — | 1 | **0 ✓** | 0 |
| **05** | `settings` | — | 4 | **0 ✓** | 0 |
| 05b | `settings` | — | 2 | **0 ✓** | 0 |
| 06 | `home` | — | 4 | **0 ✓** | 0 |
| 07 | `feedback` | — | 4 | **0 ✓** | 0 |
| 07b | `feedback` + `shared` | — | 6 | **0 ✓** | 0 |
| 08 | `chrome` | `.brand`(darwin `84px`) `#app.rail-collapsed .workspace-tab` `.pane-header` `.pane-title-input` `.pane-git` `.layout-menu-tile` | 6 | 6 | 0 |
| 08b | `chrome` | `.shortcuts-row` | 1 | 1 | 0 |

Columns sum: **33** at 01, **7** now, **0** at freeze. Every remaining violation is
named, and every name has exactly one owner — `check-spacing.mjs --list` prints the
bucket beside each, so the ledger is checkable, not asserted.

> **Bucket precedence, fixed in the 8.5/04 audit-of-the-audit.** `BUCKETS` is
> first-match-wins, and `feedback`'s `menu-` was matching `.layout-menu-tile` before
> `chrome`'s `layout-menu` could. That is the titlebar's layout menu — step 08's, via
> REMOVE #16 — so 07b's "`feedback` bucket 0" was **unreachable until 08 landed**. A
> step's definition of done must never depend on a later step. `chrome` now sits above
> `feedback`; only that one selector moved (feedback 10 → 9, chrome 6 → 7, total 27).

> The gate measures **drift**, not hitbox size: `.mgr-chip { padding: 1px var(--sp-2) }`
> and `.trail-btn { padding: 2px var(--sp-2) }` — the two worst click targets in the
> app — used *sanctioned* px and were invisible to it. **✅ 05**: both now clear 28px,
> and SETINTEG measures the rendered `getBoundingClientRect().height` rather than the
> declaration, because a gate that reads CSS text cannot see a hit target. Measured
> before: `.mgr-chip` **18.5px**, `.trail-btn` **20.5px** (and `.trail-select` was
> `26px`, so one `.trail-controls` row rendered three different control heights).

Radius is a *separate* ramp with **no** off-ramp (`--r-sm/md/lg/full`). Chrome
currently ships `3px`, `4px`, `5px` and `6px` radii with no token behind three of
them (§ Chrome). **Step 08 decides**: add `--r-xs: 3px`, or fold into `--r-sm`. The
decision and its reason go in docs/11. This is the last unresolved either/or.

---

## § Deviations — recorded, per the house rule

1. **The scale is `--sp-*`, not `--space-*`.** The brief asked for `--space-1..8`.
   A parallel scale would fork the vocabulary across **277** existing call sites —
   exactly the drift this step exists to prevent. We **extended** the ramp instead:
   `--sp-7: 48px`, `--sp-8: 64px`, for page-level rhythm the 6-stop ramp topped out
   below. The pack's later prompts have been corrected to say `--sp-*`. The
   guardrail — *"later steps may extend it, never bypass it"* — is satisfied by
   extension, which is precisely what happened.
2. **Radius already existed** as `--r-sm/md/lg/full`. No `--radius-*` added, same
   reasoning.
3. **New: readable-column caps.** `--measure: 68ch` (prose/captions) and
   `--page-max: 1040px` (settings/home column, matching the existing
   `.settings-page` width). `--measure` resolves the app's two competing prose
   measures (52ch at `:1860` vs 72ch at `:3972`).
4. **New: `--danger-ink`.** Shipping `.field-group-error` in `--danger` would have
   shipped a **measured AA failure**: the fill red is **2.93:1** on nord's elevated
   surface and **3.24:1** on solarized's. Following the existing `--accent-ink`
   precedent, danger-as-**words** now takes `--danger-ink` (`#fa9b92` dark,
   `#c92e25` light); danger-as-**fill** keeps `--danger`. Measured across all four
   themes: **0 failures, worst pair 4.52:1.**
   *Note for step 04:* `.settings-error` still renders `var(--danger)` as text —
   **a pre-existing, app-wide AA failure on nord and solarized.** Repoint it to
   `--danger-ink`. Not done here: this step is additive.
   **✅ Done in 04**, plus a gap 01 did not see: the light *first-paint* media block
   overrides `--danger` but never `--danger-ink`, so the repoint alone would have
   painted the DARK ink (#fa9b92, ≈2.2:1) on a light surface until JS pinned a
   theme — worse than the bug. Both are fixed, and SETSHELL now measures it.
5. **`TwoColumn`'s first *feature* customer is step 04**, not 01. Rewiring the
   Settings shell is 04's explicit scope, and 01's guardrail forbids behavior
   changes beyond the About tab. It ships exercised — the About card lays its
   description beside a version rail — and is gallery-staged in both themes.
6. **`FieldGroup` puts the hint under the label**, where shadcn puts the
   description under the control. The house `.settings-row` already pairs
   label+caption above the control, and 04/05 replace `row()` with `FieldGroup`;
   matching the existing pattern makes that a swap, not a re-layout.
   `hintPlacement: 'below-control'` is available for result-caveat hints.

7. **`profiles-hosts.ts`'s internals were unowned.** The Grades table read
   **D / fix**; no step's prompt claimed it — 04 covers "the shell and the light
   tabs", 05 covered "Integrations + Usage". 04 gave it the page frame (a Card with a
   real head, replacing the `row()` labelled "Pointer sets only"), promoting it to
   **C / part**. **✅ Resolved**: the pack now has **05b**, which owns its internals
   together with the other two surfaces nothing owned — the Usage tab's sibling
   popover (graded D, bugs #4/#5) and the Usage tab itself. 05 was split rather than
   stretched: a step that never mentions a surface in its Steps is how that surface
   goes unowned.

8. **02 kept the per-slot profile picker on its agent row**, though the step's
   brief listed it among the controls to collapse behind "Advanced". A profile is
   chosen *for a provider*, so the control has to sit beside that provider's name
   or it needs a second, duplicate roster inside the disclosure. It is already
   progressive: `renderRoster()` renders the `<select>` only when that provider
   has **more than one** profile (`wizard/index.ts`), which for most users is
   never. The other **six** — remote host, swarm roles, tool plan, custom command,
   preset save/delete, **worktree isolation** — are disclosed as specified. (01's
   findings list seven Advanced controls; this note used to say "five" and silently
   dropped worktree isolation from the count.)

9. **The Usage popover was RECUT to the CodexBar dropdown (08c), and USAGEUI
   re-baselined — RESOLVED.** 7/03 built the glance as grouped per-provider tiles; 08c
   recut it into the CodexBar shape — provider tabs (All · Auto · one per enabled
   provider), then the selected provider's active lane: header · windows · the pace line
   (`.usage-verdict` renders `pace.text` VERBATIM + a new `.usage-pace-delta`) ·
   credits/spend · a local-cost row · icon actions · the profile switch row · the kept
   footer. The LAYOUT is copied, the DATA is ours: every element is IPC-backed, and the
   slots CodexBar shows that we cannot back — a `$X/$Y` cap, a faked Sonnet meter,
   in-popover add-account — are dropped, never invented. The gauge, the display state
   machine (`usage.display.*`), and the pace/reset formatters are untouched.
   **USAGEUI was re-baselined to gauge-only**: its grouped-popover asserts
   (tileCount/groupCount/`.usage-switcher`, in-tile verdicts, the display-mode switcher)
   moved to the new **USAGEGLANCE** gate (a–g) — the recut is a sanctioned display change,
   and a smoke that asserts the OLD structure would block it. SETUSAGE/USAGESET/PROFILES
   and the pace golden pass unmodified (USAGESET's plans-table === popover-tiles check
   still holds — the fixture world is single-provider, so every profile tile renders).

---

## What 01 shipped

- **Tokens** (`global.css`): `--sp-7`, `--sp-8`, `--measure`, `--page-max`,
  `--side-w`, `--danger-ink` (+ its light-theme value in `core/theme/themes.ts`).
  The ramp comment now names the vocabulary and re-states the off-ramp's *scope*.
- **Primitives** (`src/ui/components/`): `card.ts`, `section-header.ts`,
  `field-group.ts`, `two-column.ts` — `el()`-built, token-only CSS, exported from
  `components/index.ts`. `SectionHeader` uses grid + `:has()` so a wrapping caption
  never drifts the action. `FieldGroup` wires `<label for>` / `role="group"`,
  `aria-describedby`, `aria-invalid`, `role="alert"`.
- **A live customer**: Settings § About, rebuilt on all four primitives
  (`settings/index.ts`), gallery-staged in both themes (`gallery.ts`).
- **AA**: measured, not asserted — 6 pairs × 4 themes, **0 failures**, worst 4.52:1.
- **Behavior**: unchanged everywhere else. Typecheck 0, build ok, boundaries clean.
