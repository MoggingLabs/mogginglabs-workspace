# Spacing & crispness audit — 6/UI pass (2026-07-03)

Method: fresh `MOGGING_SHOT=all` gallery (61 shots, both themes) reviewed
against the machined-UI checklist (off-scale spacing · touching siblings ·
clipped outer effects · broken title/content rhythm · misaligned columns),
plus a grep of `global.css` for off-ramp px literals in spacing properties.
Every row below is FIXED or WAIVED with its reason. Verification: regenerated
gallery + rail/chrome geometry probes + full 24-gate sweep.

| # | Surface | Artifact | Resolution |
|---|---------|----------|------------|
| 1 | Home | `RECENT PROJECTS` / `PRESETS` titles sat on their lists with no division; 8px gap off-rhythm | **FIXED** — house division on `.home-section > .section-label`; section gap `sp-2 → sp-3` |
| 2 | Settings | All section headers (`APPEARANCE`, `TERMINAL`, `PROFILES & SSH HOSTS`, `PRIVACY`) lacked the division | **FIXED** — same rule on `.settings-section > .section-label` (content side keeps the section's airier `sp-4`) |
| 3 | Board | Lane heads (`TO DO` …) sat directly on the card region | **FIXED** — division on `.board-lane-head` (`sp-3` + hairline; lane gap supplies the content side) |
| 4 | Wizard + Review modals | Scrollable body slid under the footer with nothing marking the fold | **FIXED** — hairline `::before` + `sp-3` on `.wizard-footer` / `.review-footer`. *(8.5/02: the wizard is no longer a modal and its `::before` was a DOUBLE divider over `.modal-footer`'s own border — the page's footer now carries a single `border-top`. `.review-footer` unchanged; 8.5/07 owns it.)* |
| 5 | Palette | Input→results seam used a full-strength border — heavier than every other title/list junction | **FIXED** — softened to the division's 55% stop |
| 6 | Pane context menu | "Copy working directory" and "Launch Claude Code here" wrapped to two lines at `min-width: 200px` | **FIXED** — `.menu { width: max-content; max-width: 320px }` + `white-space: nowrap` items (all menus) |
| 7 | Rail | Tab list gap was 3px (off-ramp) | **FIXED** — `var(--sp-1)`; the rail is a nav list, not dense chrome |
| 8 | global.css | 4px literals duplicating `--sp-1`; scattered 3/6px | **FIXED** — all `gap/padding` 4px → `var(--sp-1)`; 3/6px sanctioned as dense-chrome optical half-steps via the token-block policy note |
| 9 | Pane header | Title truncates (`cmd.e…`) while space sits empty right of the centered git chip | **WAIVED** — the `1fr auto 1fr` grid centers the git chip by design (the tmux-reference-bar convention, explicitly pinned in comments). Fixing truncation means abandoning centering — a layout decision, not a spacing fix; flagged for a dedicated design call |
| 10 | Board card | Agent chip sits 4px under the note text | **WAIVED** — exactly the `sp-1` minimum; cards are deliberately dense |
| 11 | Palette | Bottom row can sit half-cut at the list fold | **WAIVED** — mid-scroll state, not a layout defect; list already carries `sp-1` clip padding |
| 12 | Wizard agents step | `YOUR GRID` preview cells cut at the modal fold in the shot | **WAIVED** — scroll-position artifact of the capture, not layout |

Cross-checks that stayed true after the fixes: rail geometry probe (tab width /
icon x invariant across selection), chrome probe (window-control cluster),
attention-ring clip room (now `sp-3`), zero renderer errors in the gallery run.
