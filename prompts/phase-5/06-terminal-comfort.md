Thirteen-pixel terminal type causes measurable squinting over a day of agent-watching
— but oversized type wastes the 16-pane wall. Find the PERFECT default empirically,
make it adjustable, and re-verify every piece of geometry that font metrics feed
(this codebase has scars there — the width-fill bug came from exactly this).

## Steps
1. **Empirical size pick**: render the same busy pane (colored agent output, box
   glyphs, a prompt) at 13/13.5/14/15px × line-height 1.2/1.35 via a MOGGING_SHOT
   matrix mode; compare at 4-pane and 16-pane densities. Pick the default on
   readability-at-arm's-length vs rows-visible (hypothesis: **14px / 1.3** for the
   default, dropping to 13px only under user choice — decide from the shots, and
   record the matrix + rationale in `docs/11-design-system.md` § Terminal type).
2. **Settings § Terminal**: a font-size control (segmented 12–16px, default from
   step 1) + line-height stays fixed (one fewer footgun). Applied LIVE to every
   open pane: `term.options.fontSize = n` then the house `remeasureFont()` + refit
   for each pane (the existing font-metrics invalidation path — reuse, don't
   reinvent); persisted in localStorage like the layout preference; new panes read
   it at construction.
3. **Geometry re-verification** (the scar tissue): after a live size change, the
   fill probes must hold — run `MOGGING_SHOT=grid` + the reveal probe at sizes 12,
   14, 16 and assert: canvas/screen fills the viewport minus scrollbar reserve at
   EVERY size (the cols×cellW math), no dead right strip, headers unaffected. Add a
   `fontSize` loop to the reveal probe so this is a standing gate, not a one-off.
4. **Chrome that rides on terminal type**: pane header title/chips and the block
   gutter are sized relative to 13px today — re-tune so they DON'T scale with the
   terminal (chrome stays constant; only the buffer scales), and check block-mark
   alignment (OSC 133 gutter) at each size.
5. **Perception + milestone at the new default**: 16-pane MILESTONE + PERCEPTION +
   FLICKER re-run at the new default size — cell size changes GPU atlas load;
   budgets must hold unchanged. WebGL atlas warm-up after a live size change must
   not produce a visible stall (perception's churn gate catches it — add one
   size-change cycle to the perception smoke's interactive phase).

## Files
- `src/ui/features/terminal/terminal-pane.ts` (size option + live apply path)
- Settings § Terminal section · `src/main/shot.ts` (matrix mode; probe fontSize loop)
- `src/main/perception-smoke.ts` (size-change cycle) · `docs/11-design-system.md`
- gallery (density comparisons)

## Definition of Done
- A shot-justified default that reads comfortably at 4 panes AND stays useful at 16;
  a live Settings control (12–16px) that never breaks fill geometry at any size;
  chrome decoupled from buffer type size.
- All three perf/artifact gates green at the new default.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- SMOKE (reflow/fill asserts), MILESTONE, FLICKER, PERCEPTION (with the size-change
  cycle) green; the multi-size reveal probe green at 12/14/16.
- The size matrix + before/after density shots committed to the gallery.

## Guardrails
- Every size change goes through the existing remeasure→refit pipeline — no second
  metrics path (the width-fill bug must stay dead).
- Line-height is fixed by design; only fontSize is user-facing.
- Chrome (headers, chips, gutters) NEVER scales with terminal fontSize.
- 13px remains selectable — some users genuinely prefer density; the DEFAULT is
  what changes.
