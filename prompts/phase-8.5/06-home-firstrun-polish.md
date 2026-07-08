Home + first-run (Phase-8.5/06). Home is the first thing a fresh install sees. This
step applies the 01 system to Home and the checklist, and fixes the bug that makes
the checklist immortal.

## Steps
1. **Home layout** (`features/home/index.ts`): a token-padded page on the readable
   column — hero (mark + "New workspace" + "Open recent"), then a Recents grid of
   `Card`s (folder · path caption · pane/provider chips · relative last-open)
   replacing the bare list, whose `4px` seam is the audit's rhythm-inversion
   exhibit. Empty state → house `EmptyState` + the wizard CTA.
2. **Fluid spacing, honestly.** The four `clamp()` spacing bypasses
   (`.home-logo{margin-bottom}`, `.home-welcome`, `.home-ctas`, `.home-sections`)
   take `--sp-*` stops. `.home-hero { margin-top: 3vh }` is a FIFTH that
   `check-spacing.mjs` **cannot see** (px only); fix it too. KEEP the *sizing*
   clamps — `.home-logo` w/h/radius, `.home-title` font — they are fluid behavior.
3. **First-run checklist** (`home/firstrun.ts`): one `Card`, per-row icons,
   done-state styling, install one-liners in code chips with the copy button on the
   same baseline (its `1px`/`3px` pads wrap today). **Bug #1 — the card can never
   self-dismiss**: `:176` omits `optional:true` while its title says "Optional:", and
   the gate is `rows.every(r => r.done || r.optional)`. `product-smoke.ts:100-102`
   MASKS it by saving two profiles first — unmask it in the same commit. Then REMOVE
   #21: delete that row (no action button, a 3-way OR), which also makes the "Three
   steps" copy true. Rows still tick from REAL state (6/01). `firstrun.ts:81` borrows
   `icon('folder')` for copy because **no `copy` glyph exists** — add one.
4. **Update UX** (`updates/index.ts`): REMOVE #15 — `--pct` is computed and handed
   to the dot, nothing reads it, progress survives only in the `title`. Render it or
   delete it; graded A− solely for this.
5. **The AA probe, shareable and un-forgettable.** 04 wrote the repo's first WCAG
   probe (sRGB linearization, relative luminance, alpha compositing) inside
   `setshell-smoke.ts`; the "Phase-5 probe" older prompts cite never existed. Extract
   it to `src/main/aa-probe.ts`, which must **own the transition freeze**: a
   mid-flight `transition` hands `getComputedStyle` a frame of the fade — under sweep
   load SETSHELL read 1.72:1 where it reads 4.71:1 settled. Export ONE call that
   freezes, measures every theme, thaws — a caller cannot forget what it never had
   to remember. SETSHELL + HOMEUX import it; 07/07b/08/08b/09 reuse.
6. **HOMEUX smoke** (`MOGGING_HOMEUX`): fresh userData — (a) hero + `EmptyState`,
   wizard opens from the CTA; (b) checklist rows are detection-honest (no CLI →
   install row + copy chip); (c) seed a recent → reopen → card renders and opens the
   workspace; (d) with every REQUIRED row done and none saved-by-fixture, the card
   self-dismisses (bug #1's test) and never returns; (e) computed: hero→grid gap ≥
   `--sp-6`, card padding ≥ `--sp-4`; (f) AA on card text, four themes, via
   `aa-probe.ts`. Verdict `out/homeux-result.json`.

## Files
- `features/home/index.ts` · `home/firstrun.ts` · `features/updates/` ·
  `components/icons.ts` (copy) · home CSS · `src/main/aa-probe.ts` ·
  `homeux-smoke.ts` · `setshell-smoke.ts` (import it) · `product-smoke.ts` (unmask)
  · dispatch · qa-smokes.sh · gallery

## Definition of Done
- AUDIT grades **Home C+ → A**, **First-run B− → A**, **Update UX A− → A**.
- `home` bucket **0** (it *is* the four clamps); the unseeable `3vh` is gone.
- FIRSTRUN + PRODUCT green (PRODUCT with its mask removed); HOMEUX green.
  REMOVE #15, #21 ✅; bug #1 ✅.

## Checks that must be green
- typecheck 0; build ok; boundaries clean; full sweep; PERCEPTION + MILESTONE.

## Guardrails
- Detection honesty is the checklist's soul — restyle it, never fake a tick.
- Recents show basename + a short path; full paths stay out of telemetry.
