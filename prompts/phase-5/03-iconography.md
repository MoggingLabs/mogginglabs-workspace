Our icon set is a sparse, hand-picked subset that grew one glyph at a time — weights
vary, metaphors are sometimes obscure (the kanban chip, the expand arrows), and
several surfaces reuse whatever was nearby ('folder' for claims, 'terminal' for
mail-ish things). BridgeSpace's icons read INSTANTLY. Rebuild ours as one consistent,
intent-revealing system — still inline SVG, still zero dependencies.

## Steps
1. **Inventory + mapping** (`docs/11-design-system.md` § Icons): list every icon USE
   (grep `icon(` across `src/ui/`) with its surface and intent. For each, decide:
   keep / redraw / replace-metaphor. Priorities called out today: kanban (board),
   settings gear (weight-match), home, panel-left (rail toggle), the four pane
   actions (⋯ / expand-full / expand-h / expand-v / close — the expand trio must be
   instantly distinguishable), git-branch, state dot alternatives, role/claims/remote
   chip glyphs, wizard step icons, toast tone icons, board card menu.
2. **The set**: redraw on a strict 24×24 grid, 1.75 stroke, round caps/joins
   (lucide-compatible conventions so future additions match). Source from lucide's
   OPEN path data where the metaphor fits (it's ISC-licensed — vendor the path
   strings with attribution in the file header), hand-adjust where our size (11–15px
   render) needs simplification: at 12px, detail must be DROPPED, not squeezed —
   provide simplified variants for the pane-action size where needed.
3. **Rendering quality**: audit every `icon(name, size)` call — snap rendered sizes
   to the grid (11px → 12px etc.), ensure stroke-width compensates at small sizes
   (a `size <= 12 -> stroke 2` rule in the icon helper), verify crispness on
   non-integer DPRs via shots at 100%/125%/150% zoom equivalents.
4. **Intent polish while there**: pane actions get clearer affordances (hover bg +
   tooltip audit — every icon button MUST have a title/aria-label; grep-assert);
   the board/home/settings titlebar cluster gets the weight-matched trio; chips
   (role/claims/remote/approved) get purpose-drawn micro-glyphs instead of borrowed
   ones.
5. **Verify**: an icon-sheet shot (a dev-only `__mogging.iconSheet()` that renders
   the full set at 12/16/24px into a hidden container for MOGGING_SHOT) committed to
   the gallery, both themes; plus re-shots of every surface whose glyphs changed.

## Files
- `src/ui/components/icons.ts` (the set + size-aware stroke) · every `icon(` call
  site that changes name/size · `docs/11-design-system.md` § Icons · gallery

## Definition of Done
- One visual family: same grid, same stroke feel, at every rendered size, both
  themes; every icon's meaning guessable without the tooltip (and every icon button
  HAS a tooltip).
- The expand trio, kanban, settings, and rail toggle read instantly (the named
  complaints), verified by the icon sheet + surface shots.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- SMOKE + PANEOPS + BOARD + ATTENTION still green (icons live inside asserted DOM;
  class names/aria-labels used by smokes — e.g. `[aria-label="Home"]`,
  `[aria-label="Settings"]`, `[aria-label="Add profile"]` — are FROZEN).
- Icon sheet + affected-surface shots in the gallery, both themes.

## Guardrails
- Inline SVG path strings only — no icon font, no npm package, no build step.
- Licensing hygiene: vendored lucide paths get a one-line ISC attribution in
  icons.ts; hand-drawn ones are ours.
- IconName is a growing union — never repurpose an existing name to a different
  metaphor (call sites pick new names); delete truly-unused names in the same pass.
