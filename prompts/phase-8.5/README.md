# Phase 8.5 — the UI/UX revamp: audit first, then every surface earns its keep

Sequenced task prompts for the intermediate phase between 8 and 9 of
**MoggingLabs Workspace**. Phases 6–8 grew the product fast — usage meters,
five integration directions, a browser, a swarm — and the CHROME didn't keep
up: the wizard is three cramped screens, the folder picker is a `cd` bar,
Settings is functional but unstyled (no padding, no components, no margins),
and surfaces that made sense at Phase 3 now duplicate or contradict newer
ones. This pack is one full **audit** followed by a **visual revamp** of every
user-facing surface, plus removals: things the product outgrew get deleted,
not restyled. Same format as `prompts/phase-1..8/` (each step self-contained +
pasteable as a `/goal`, **≤ 3950 chars**). Execute in order.

> **Why 3950, not 4000.** `/goal` hard-caps the *whole* condition at 4000
> characters, and you prepend your own preamble ("Use Opus 4.8 / Fable 5 only,
> …" ≈ 50 chars) before pasting a step. A 3999-char step therefore fails to set.
> Every step here is kept ≤ 3950 with real headroom (currently 3578–3888, min 62
> spare). Verify after editing any step:
> `python3 -c "import sys;[print(len(open(f,encoding='utf-8').read()),f) for f in sys.argv[1:]]" prompts/phase-8.5/[0-9]*.md`
> — count **characters**, not bytes: these files carry multibyte `·`, `—`, `≥`.

> **Design-source rule (binding)**: 21st.dev (and similar galleries) are a
> RESEARCH source — browse free components for layout/spacing/interaction
> ideas and record what informed what in AUDIT.md. But this renderer is
> vanilla TS + house CSS tokens (ADR 0004; no React, no Tailwind, no runtime
> deps): every adopted pattern is re-implemented clean-room on the Phase-5
> token system (`src/ui/styles/global.css`) and the house component library
> (`src/ui/components/`). No pasted component code, no license ambiguity —
> patterns in, our code out.

> **The spacing doctrine (corrected by 01's audit)**: a scale ALREADY existed
> (`--sp-1..6`, 277 call sites). The real defects are structural — there is not
> one `Card` in the app, and separation *between* groups is routinely ≤
> separation *within* them. So 01 EXTENDS the ramp (`--sp-7/8`) and ships the
> missing vocabulary: `Card` · `SectionHeader` · `FieldGroup` · `TwoColumn`.
> Every later step consumes those; `node scripts/check-spacing.mjs` is the gate.

> **Ground truth**: the wizard WAS a 3-step modal (`wizard/index.ts`, ~944
> lines); **02 made it a full page** (`#view-wizard`, beside the rail). The folder
> input is `createPathInput` (`src/ui/components/input.ts` — a typed path/`cd`
> bar + native Browse); Settings is `src/ui/features/settings/` (index 402 ·
> integrations 1174 · usage 638 · profiles-hosts 296 lines) rendered as one
> nav + hidden sections. Budgets (docs/05 + docs/07) and the sweep (52 gates at
> the start of this pack; **66 at freeze** — § Freeze) are the regression net —
> every step re-runs the perception-critical gates.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-ux-audit-and-spacing-tokens.md` | AUDIT.md (every surface graded, keep/fix/remove verdicts, 21st.dev pattern notes) + the ramp extension & layout primitives; typecheck/build green |
| 02 | `02-wizard-single-page.md` | The wizard becomes ONE full-app PAGE beside the rail — not a modal; WIZARDUX green |
| 03 | `03-folder-browser.md` | A real visual folder browser under the path bar — one selection, three views; `fs:listDir` read-only; FOLDERPICK green |
| 04 | `04-settings-shell-revamp.md` | The Settings shell on the primitives — grouped nav, per-tab SectionHeader, Cards + FieldGroups + a new ToggleRow; the repo's first real WCAG probe; SETSHELL green |
| 05 | `05-settings-integrations.md` | Integrations (**F**) → overview-first with progressive disclosure; `.mgr-chip`/`.trail-btn` hitboxes; SETINTEG green |
| 05b | `05b-settings-usage-and-profiles.md` | The three surfaces nothing owned: Usage tab (D−), the Usage **popover** (D), Profiles & hosts (D); SETUSAGE green |
| 06 | `06-home-firstrun-polish.md` | Home + first-run; the checklist that can never self-dismiss; the AA probe extracted for reuse; HOMEUX green |
| 07 | `07-board-and-palette.md` | Board (D) + palette (C−); `Delete card` gets a confirm; BOARDUX green |
| 07b | `07b-feedback-family.md` | One feedback language; the opt-out-able destructive confirm; the review modal's safe-last footer; 26 empty states; FEEDBACKUX green |
| 08 | `08-chrome-titlebar-rail-panes.md` | Titlebar, rail, pane headers; the radius ramp decided; CHROMEUX green |
| 08b | `08b-dock-and-shortcuts.md` | **§ Blockers #1**: the possession surface has no CSS rule and no test. Guard first, then restyle; DOCKUX green |
| 08c | `08c-usage-glance-codexbar.md` | The Usage popover **recut** to the CodexBar dropdown — provider tabs + one provider's windows · cost · actions, on our data; gauge untouched; USAGEGLANCE green |
| 09 | `09-ux-milestone.md` | UXMILESTONE + `check-audit.mjs` (no Grades row below A, no unrouted finding) + `check-spacing --max 0` + four-environment certification |

> **Why 13 steps for 9 numbers.** 05, 07 and 08 each tried to carry two surfaces'
> worth of work, and 05 never even named `profiles-hosts.ts` in its Steps — which is
> exactly how that surface ended up graded **D** with no owner. A step that cannot
> state its scope in 3950 characters cannot be executed honestly either. Split, with
> the `06b` precedent from phase-1. 08c is that move once more: the Usage popover's
> CodexBar recut is a design change with its own gate (USAGEGLANCE) and an AA re-measure
> — not a restyle 05b could absorb.

## Overall Definition of Done
- AUDIT.md covers EVERY feature surface with a keep/fix/remove verdict and
  every remove executed (dead affordances deleted, not hidden).
- The wizard is one uncluttered page; a folder is pickable by click alone.
- Settings reads as a designed product: cards, spacing, section rhythm — no
  wall of unlabeled controls anywhere.
- All spacing flows from the token scale; `scripts/check-spacing.mjs` finds no
  new hardcoded px margins in feature CSS.
- Both perf budgets (MILESTONE + PERCEPTION) unchanged; all pre-existing gates
  still green; the new gates green on all four environments.
- `check-spacing.mjs --max 0` — every bucket zero, including the shared row.
- `check-audit.mjs` green: **no Grades row below A**, every REMOVE ✅, every one
  of the 13 bugs owned and resolved, both Blockers discharged, every Deviation
  resolved. Twelve of those bugs had no owner until the 8.5/04 audit-of-the-audit.

## Guardrails
- **No new runtime deps** — 21st.dev informs, house code ships (ADR 0004).
- **Behavior-preserving unless AUDIT.md says remove** — every functional
  contract (channels, smokes) keeps passing; visual-only diffs elsewhere.
- **Tokens only** — colors/spacing/type from the Phase-5 system; AA contrast
  measured for anything new, both themes.
- **Budgets are the veto** — a prettier surface that costs frame time loses.
- Gallery restaged for every touched surface (both themes); books cite smoke
  output + run ids, never screenshots-as-proof.

## Parallelization
01 is the root. After it: Lane A (02 → 03, the wizard), Lane B (04 → 05 → 05b,
Settings), Lane C (06 → 07 → 07b → 08 → 08b → 08c, the rest; 08c also needs 05b). 09
needs all lanes.
Solo execution runs 01 → 09 in order (house rule: no parallel agents).

## Freeze — Phase-8.5/09 (2026-07-09)

The pack is **frozen**. Every surface shipped at grade **A**, every gate green on
four environments, both perf budgets unmoved. `check-audit.mjs` is the assertion that
holds it there: AUDIT.md has no Grades row below A and no unrouted finding.

**Commit range:** `7397938..2d4f765` (pack open → freeze). It landed in phased
commits — 05b/06/07/07b together in `489ee3a`, 08/08b/08c in `3862a2b`, the
audit-of-the-audit in `19c2b9a`; the 09 milestone + coverage gate in `638481f`, its two
certification platform-find fixes in `b6548b1` (pane-header) and `2d4f765` (FOLDERPICK).

| Step | Gate | Done |
|---|---|---|
| 01 — audit + layout primitives | AUDIT.md · check-spacing | ✅ `7ce218c` |
| 02 — wizard, one page | WIZARDUX | ✅ `7937bf1` |
| 03 — folder browser | FOLDERPICK | ✅ `d07af48` |
| 04 — Settings shell | SETSHELL | ✅ `5a325be` |
| 05 — Integrations (F → A) | SETINTEG | ✅ `6c03c35` |
| 05b — Usage + profiles | SETUSAGE | ✅ `489ee3a` |
| 06 — Home + first-run | HOMEUX | ✅ `489ee3a` |
| 07 — board + palette | BOARDUX | ✅ `489ee3a` |
| 07b — feedback family | FEEDBACKUX | ✅ `489ee3a` |
| 08 — chrome (radius ramp decided) | CHROMEUX | ✅ `3862a2b` |
| 08b — dock possession + shortcuts | DOCKUX | ✅ `3862a2b` |
| 08c — Usage-glance recut | USAGEGLANCE | ✅ `3862a2b` |
| 09 — milestone + freeze | UXMILESTONE · check-audit | ✅ `638481f`…`2d4f765` |

**The 09 freeze gates (measured, not asserted):**
- `MOGGING_UXMILESTONE` — the whole revamp composed in one fixture world, zero
  network; every legacy DOM hook resolves; a seeded attention chip shows through a
  **collapsed** header on both Settings surfaces. Safety **AA undimmed**: worst
  **4.72:1** across four themes (possession label, consent copy, an attention chip,
  the review-gate indicator, the trail's "never sent anywhere" line). Budgets sampled
  DURING the composed surface against the UNCHANGED `docs/05` numbers — worst frame
  gap **13.9ms** (budget 150), heap **20MB** (budget 300), 0 frames > 100ms. It also
  earned its keep: it caught `--danger-ink` on the tinted `--danger-weak` chip fill at
  4.45:1 on light (below AA on a ground the plain-surface pairs never covered), now
  darkened to `#c02820` (~4.87:1) — see AUDIT § Deviations 4.
- `check-audit.mjs` — no Grades row below A, all 21 REMOVE rows ✅, all **16** bugs
  owned + resolved, both Blockers discharged, all 9 Deviations resolved.
- `check-spacing.mjs --max 0` — 0 violations, every bucket including the shared row.

**Four-environment certification.** Full uncut sweeps — all **66 gates** (64 Electron
smokes + the two static gates AUDIT · SPACING) green on local Windows AND all three CI
OSes in one clean dispatch: run
[**29006301457**](https://github.com/MoggingLabs/mogginglabs-workspace/actions/runs/29006301457).

| Environment | Gates | Notes |
|---|---|---|
| local Windows 11 | **66/66** | full sweep; MILESTONE + BOARDUX green on standalone re-run (the contention pattern; RAM 6.7 GB) |
| CI Windows | **66/66** | `windows-latest` · Git Bash · `MOGGING_CI_GPU=soft` |
| CI Linux | **66/66** | `ubuntu-latest` · xvfb · gnome-keyring · `MOGGING_CI_GPU=soft` |
| CI macOS | **66/66** | `macos-26` · coreutils · `MOGGING_CI_GPU=soft` |

The first dispatch (`29002525980`) surfaced two platform finds — the pane-header
one-line proxy on soft-GL (CHROMEUX + UXMILESTONE) and the FOLDERPICK deny fixture on
the windows-CI runner — both root-caused (`b6548b1`, `2d4f765`), then re-certified clean
above. `REPORT.md` carries the root causes. Nightly crons stay enabled.

**Next:** `prompts/phase-9/` (Loops — standing harnesses; ADR 0009) is authored and
holds. 8.5 hands off with the sweep at 66 gates and both budgets frozen.
