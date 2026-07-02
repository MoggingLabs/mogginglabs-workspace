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
| 01 | `01-audit-and-color-system.md` | Every surface screenshotted (both themes); findings ledger; vivid per-workspace color ramps + crisp neutrals with an AA-validated table; `docs/11-design-system.md` |
| 02 | `02-workspace-rail-selection.md` | Selected workspace = full-button treatment in ITS color (outline + inner tint + heavy left bar); attention stays brand-orange; rail typography polish (smoke-safe) |
| 03 | `03-iconography.md` | A complete, consistent 24-grid icon set (weight-matched, intent-revealing) replacing the sparse hand-rolled one; per-surface picks documented |
| 04 | `04-window-chrome.md` | Centered command box; F11 fullscreen collapses the controls gap; bottom corners of the content follow the window's rounded corners (no clipped outlines) |
| 05 | `05-full-app-views.md` | Home, Settings (modal → PAGE), and Board own the ENTIRE app below the titlebar — rail only exists in the grid view; smokes updated intentionally |
| 06 | `06-terminal-comfort.md` | Terminal type tuned for zero eye strain (size/line-height picked by shot comparison) + a Settings font-size control; geometry probes re-verified |
| 07 | `07-polish-milestone.md` | Before/after gallery of every surface; full 24-gate sweep green; perception budget re-passed; REPORT + version bump material |

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
