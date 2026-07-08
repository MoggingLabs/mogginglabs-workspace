Home + first-run (Phase-8.5/06). Home is the first thing a fresh install sees.
This step applies the 01 system to Home and the checklist, and fixes the bug
that makes the checklist immortal.

## Steps
1. **Home layout** (`features/home/index.ts`): a token-padded page on the
   readable column — hero (mark + "New workspace" primary + "Open recent"), then
   a Recents grid of `Card`s (folder · path caption · pane/provider chips ·
   relative last-open) replacing the bare list. Its `4px` seam between bordered
   rows is the audit's rhythm-inversion exhibit. Empty state → house `EmptyState`
   with the wizard CTA; a first boot must not be a blank pane.
2. **Fluid spacing, honestly.** The four `clamp()` spacing bypasses —
   `.home-logo{margin-bottom}`, `.home-welcome{margin}`, `.home-ctas{margin-top}`,
   `.home-sections{gap}` — take `--sp-*` stops. `.home-hero { margin-top: 3vh }`
   is a FIFTH bypass that `check-spacing.mjs` **cannot see** (it reads px only);
   fix it too. KEEP the *sizing* clamps: `.home-logo` w/h/radius and
   `.home-title` font are justified fluid behavior, not spacing.
3. **First-run checklist** (`home/firstrun.ts`): one `Card`, per-row icons,
   done-state styling, install one-liners in code chips with the copy button on
   the same baseline (its `1px`/`3px` pads wrap today). **Bug #1 — the card can
   never self-dismiss**: `:176` omits `optional:true` while its title says
   "Optional:", and the gate is `rows.every(r => r.done || r.optional)`.
   `product-smoke.ts:100-102` MASKS it by saving two profiles first — unmask the
   gate in the same commit. Then REMOVE #21: delete that row (no action button, a
   3-way OR of unrelated features), which also makes the "Three steps" copy true.
   Rows still tick from REAL state (the 6/01 lesson). `firstrun.ts:81` borrows
   `icon('folder')` for copy because **no `copy` glyph exists** — add one.
4. **Update UX** (`updates/index.ts`): REMOVE #15 — `--pct` is computed and
   handed to the dot, nothing reads it, and progress survives only in the
   `title`. Either render it or delete it; graded A− solely for this.
5. **The AA probe, made shareable.** 04 wrote the repo's first WCAG probe (sRGB
   linearization + relative luminance + alpha compositing) inside
   `setshell-smoke.ts` — there was never a "Phase-5 probe" to reuse. Extract it
   to `src/main/aa-probe.ts`; SETSHELL and HOMEUX both import it. 07/08/09 reuse
   it after that.
6. **HOMEUX smoke** (`MOGGING_HOMEUX`, env-gated, qa-smokes.sh): fresh userData —
   (a) hero + `EmptyState`, wizard opens from the CTA; (b) checklist rows are
   detection-honest (no CLI → install row + copy chip); (c) seed a recent →
   reopen → card renders and opens the workspace; (d) with every REQUIRED row
   done and none saved-by-fixture, the card self-dismisses (bug #1's regression
   test) and never returns; (e) computed: hero→grid gap ≥ `--sp-6`, card padding
   ≥ `--sp-4`; (f) AA on card text, four themes, via `aa-probe.ts`. Verdict
   `out/homeux-result.json`.

## Files
- `features/home/index.ts` · `home/firstrun.ts` · `features/updates/` ·
  `components/icons.ts` (copy) · home CSS on tokens · `src/main/aa-probe.ts` ·
  `homeux-smoke.ts` · `setshell-smoke.ts` (import the probe) ·
  `product-smoke.ts` (unmask) · main dispatch · qa-smokes.sh · gallery

## Definition of Done
- AUDIT grades **Home C+ → A**, **First-run B− → A**, **Update UX A− → A**.
- The `home` bucket reaches **0** (it *is* the four clamps) and the `3vh` the
  checker cannot see is gone.
- FIRSTRUN + PRODUCT green — PRODUCT with its mask removed; HOMEUX green.
  REMOVE #15, #21 ✅; bug #1 ✅.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Detection honesty is the checklist's soul — restyle it, never fake a tick.
- Recents show basename + a shortened path; full paths stay out of telemetry.
