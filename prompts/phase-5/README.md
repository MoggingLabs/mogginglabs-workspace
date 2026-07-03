# Phase 5 — UI/UX excellence: look like the product we already are

Sequenced task prompts for Phase 5 of **MoggingLabs Workspace**: the engine outruns
every competitor — the SURFACE doesn't yet. BridgeSpace beats us on color usage,
selection treatments, and iconography; our own chrome still has artifacts (corner
clipping, fullscreen gaps, a modal that should be a page). This phase is a full
UI/UX sweep: audit everything, rebuild the color system around VIVID per-workspace
identity, upgrade the icon set, fix the window chrome, make top-level views own the
whole app, and tune terminal comfort. Same format as `prompts/phase-1..4/` (each
step self-contained + pasteable as a `/goal`). Execute in order — 01's audit ledger
and design tokens feed every later step. Each step file is < 4000 chars.

> The product identity stays OURS (logo orange #FD8D03, JetBrains Mono, dark-first) —
> we take BridgeSpace's *standards* (vivid color, weight, intent-revealing icons),
> never its look. Inspiration screenshots live in `assets/Inspiration/`.

## Where Phase 4 (+ polish) left us
- Full feature surface: launcher Home, wizard, 1–16-pane grids, board, review modal,
  Settings modal (theme/profiles/hosts/telemetry), palette, toasts, pane chrome
  (state/role/claims/remote/git chips), rail with attention counts.
- The HOUSE VERIFICATION LOOP is the superpower: `MOGGING_SHOT` screenshots +
  geometry probes caught every real UI bug so far — every step here must ship
  before/after shots and probe numbers, not adjectives.
- Budgets enforced (machine 150 ms/30 fps/300 MB · perception ≤100 ms, zero >100 ms
  frames) and 24 smoke gates green — several assert LOAD-BEARING DOM contracts
  (`.workspace-tab[data-attention]`, `.pane-state[data-state]`, `.pane-git.has-git`,
  `.layout-slot[data-pane-id]`, `.pane-label.has-label`, `.settings-error`,
  `.board-chip-*`, `.pane-role/.pane-claims/.pane-remote`). Restyle freely; break
  selectors NEVER (or update the smoke in the same step, intentionally).

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-audit-and-color-system.md` | **DONE** (`7cbc8aa`): MOGGING_SHOT=all gallery (46 shots, both themes); ledger UX-01…23; identity ramps (--ws-accent/ink/tint/edge/glow, amber→green, AA-measured); neutrals/semantics re-tuned both themes; scrim/selection/fs-10 tokenized; docs/11 with contrast tables |
| 02 | `02-workspace-rail-selection.md` | **DONE** (`93c2f91`): selected tab = tint wash + 1px edge + 3px inset left bar + ink label (zero layout shift, probe-rail.json); attention → soft brand glow + badge, composes with selection; paint-only states (PERCEPTION ×2); collapsed rail inherits |
| 03 | `03-iconography.md` | **DONE** (`e972e32`): lucide-convention family, size-aware stroke + ≤12px variants; expand trio/kanban/sliders/flag/globe/info; 10 dead names deleted; icon sheet at 100/125/150%; SMOKE+PANEOPS+BOARD+ATTENTION green |
| 04 | `04-window-chrome.md` | **DONE** (`6160bb1`): 3-col titlebar grid (true-center command box, ≤1.5px probed); shell:windowState events (state from event identity — Windows isFullScreen() lags the event); env()-flap reserve floor; --window-corner harmony; state matrix ×2 themes |
| 05 | `05-full-app-views.md` | **DONE** (`0ce5501`): AppView+settings, rail grid-only, Settings modal→page (state survives leave/return), goBack history, empty-grid→Home (UX-16); PROFILES/BOARD smokes updated in-step; 7 gates green |
| 06 | `06-terminal-comfort.md` | **DONE** (`5acaf7f`): empirical 14px/1.3 default (typematrix committed); live 12–16px control via the house remeasure→refit; standing multi-size reveal probe (sizesPass, 110/96/86 cols); perception size-churn gate (27.8 ms max gap) |
| 07 | `07-polish-milestone.md` | **DONE** (freeze commit): ledger fully closed (19 fixed · 1 by-design · 3 deferred w/ reasons); REPORT.md before/after pairs + the four cross-cutting audits; --dur-2→150 ms; role chips de-collided; full 24-gate sweep green; budgets vs Phase-4 recorded |

## Overall Definition of Done
- Every surface passes the audit checklist: crisp AA-safe colors, vivid selection in
  workspace identity colors, consistent icons, no chrome artifacts at any window
  state (restored/maximized/F11), full-app top-level views, comfortable terminals.
- Zero regressions: all 24 gates green, MILESTONE + PERCEPTION budgets unchanged,
  every load-bearing selector intact or intentionally migrated WITH its smoke.
- The before/after gallery makes the upgrade undeniable at a glance.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- EVERY visual change verified by `MOGGING_SHOT` screenshots (and geometry probes
  where pixels matter) — in BOTH themes — before the step closes.
- PERCEPTION re-run after any step touching render paths; SMOKE + the step's
  affected gates isolated via `scripts/qa-smokes.sh`.

## Guardrails
- Tokens only: no hard-coded colors in feature CSS — everything routes through the
  design-token layer 01 establishes (both themes, AA-validated).
- No new dependencies; icons stay inline SVG; fonts stay JetBrains Mono.
- The perf/perception budgets are non-negotiable — beauty that stutters is a bug.
- Smoke DOM contracts: restyle ≠ rename. Any selector change ships WITH its smoke
  update in the same step and is called out in the step report.

## Parallelization
01 first (it feeds everything). Then: 02+03 (lane A — rail + icons share the color
system), 04 (lane B — chrome), 05 (lane C — views), 06 (lane D — terminals). 07
freezes the phase and needs all lanes.
