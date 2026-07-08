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
pasteable as a `/goal`, < 4000 chars). Execute in order.

> **Design-source rule (binding)**: 21st.dev (and similar galleries) are a
> RESEARCH source — browse free components for layout/spacing/interaction
> ideas and record what informed what in AUDIT.md. But this renderer is
> vanilla TS + house CSS tokens (ADR 0004; no React, no Tailwind, no runtime
> deps): every adopted pattern is re-implemented clean-room on the Phase-5
> token system (`src/ui/styles/global.css`) and the house component library
> (`src/ui/components/`). No pasted component code, no license ambiguity —
> patterns in, our code out.

> **The spacing doctrine (the root fix)**: the audit's #1 finding class is
> density — zero padding/margins on functional surfaces. Step 01 adds a
> SPACING SCALE to the token system (4/8/12/16/24/32) and a small set of
> layout primitives (Card, FieldGroup, SectionHeader, TwoColumn). Every later
> step consumes those — no ad-hoc pixel values, so the fix is systemic, not
> per-screen.

> **Ground truth**: the wizard is `src/ui/features/wizard/index.ts` (3 steps:
> Start · Layout · Agents, ~944 lines); the folder input is
> `createPathInput` (`src/ui/components/input.ts` — a typed path/`cd` bar +
> native Browse); Settings is `src/ui/features/settings/` (index 402 ·
> integrations 1174 · usage 638 · profiles-hosts 296 lines) rendered as one
> nav + hidden sections. Budgets (docs/05 + docs/07) and the 52-gate sweep
> are the regression net — every step re-runs the perception-critical gates.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-ux-audit-and-spacing-tokens.md` | AUDIT.md (every surface graded, keep/fix/remove verdicts, 21st.dev pattern notes) + the spacing scale & layout primitives in tokens/components; typecheck/build green (ships minimal runtime) |
| 02 | `02-wizard-single-page.md` | The wizard becomes ONE page (folder · layout · agents visible at once, breathing room, live summary); WIZARDUX smoke green |
| 03 | `03-folder-browser.md` | A real visual folder browser (clickable dirs, breadcrumb, keyboard nav, repo badges) beside the path bar; FOLDERPICK smoke green |
| 04 | `04-settings-shell-revamp.md` | The Settings shell on the new primitives — cards, section headers, spacing, consistent controls; SETSHELL smoke green |
| 05 | `05-settings-dense-tabs.md` | Integrations + Usage tabs restructured on the primitives (progressive disclosure, no wall-of-knobs); INTEGUX + USAGESET still green + SETTABS asserts |
| 06 | `06-home-firstrun-polish.md` | Home + first-run checklist visual pass + stale-affordance removals from AUDIT.md; HOMEUX smoke green |
| 07 | `07-board-palette-feedback.md` | Board, palette, toasts, empty states, confirms — one feedback language; BOARDUX smoke green |
| 08 | `08-chrome-and-terminal-ux.md` | Titlebar, workspace tabs, pane headers, dock chrome, shortcuts overlay — density + consistency + audit removals; CHROMEUX smoke green |
| 09 | `09-ux-milestone.md` | UXMILESTONE: the revamped surfaces asserted end-to-end, budgets unchanged, gallery restaged (both themes), books + four-environment certification |

## Overall Definition of Done
- AUDIT.md covers EVERY feature surface with a keep/fix/remove verdict and
  every remove executed (dead affordances deleted, not hidden).
- The wizard is one uncluttered page; a folder is pickable by click alone.
- Settings reads as a designed product: cards, spacing, section rhythm — no
  wall of unlabeled controls anywhere.
- All spacing flows from the token scale; grep finds no new hardcoded px
  margins in feature CSS.
- Both perf budgets (MILESTONE + PERCEPTION) unchanged; all pre-existing 52
  gates still green; the new gates green on all four environments.

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
01 is the root. After it: Lane A (02 → 03, the wizard), Lane B (04 → 05,
Settings), Lane C (06 → 07 → 08, the rest of the app). 09 needs all lanes.
Solo execution runs 01→09 in order (house rule: no parallel agents).
