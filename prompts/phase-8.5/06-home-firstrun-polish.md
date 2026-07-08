Home + first-run polish (Phase-8.5/06). Home is the first thing a fresh
install sees and the hub returning users pass through — it must sell the
product's care in two seconds. This step applies the 01 system to Home and
the first-run checklist, and executes the AUDIT.md keep/fix/remove verdicts
for both, including anything Phase-6's checklist promised that Phase-8's
guided integrations flow now does better.

## Steps
1. **Home layout** (`src/ui/features/home/index.ts`): a token-padded page
   on the readable-column width — hero row (product mark + "New
   workspace" primary + "Open recent" secondary), then a Recents grid of
   `Card`s (folder name · path caption · pane-count/provider chips ·
   relative last-open) replacing whatever list/rows exist; hover states,
   consistent radii, both themes. Empty state (no recents) uses the house
   `EmptyState` with the wizard CTA — the first-boot moment must not be a
   blank pane.
2. **First-run checklist** (`home/firstrun.ts`): the live checklist keeps
   its detection-honest rows (the 6/01 lesson: rows tick from REAL state,
   collapse only when a CLI is installed) but renders as a single `Card`
   with per-row icons, done-state styling, and the provider install
   one-liners in proper code chips with the copy button aligned. Check
   the row set against Phase 8: if the "Connect your stack" guided flow
   (8/13) supersedes a row's promise, the row LINKS to it rather than
   duplicating; if AUDIT.md marked a row stale, remove with rationale.
   Dismiss/never-return behavior unchanged.
3. **Update UX touchpoint**: the update banner/toast that lands on Home
   gets the 07 feedback language early if trivial (one Card banner style)
   — else note it for 07; no logic change either way.
4. **Audit removals in scope**: Home-area REMOVE verdicts executed (dead
   quick-links, duplicated New-workspace affordances beyond hero + tab
   strip, stale copy).
5. **HOMEUX smoke** (`MOGGING_HOMEUX`, env-gated, qa-smokes.sh): fresh
   userData boot — (a) Home renders the hero + EmptyState (no recents),
   wizard opens from the CTA; (b) checklist card renders with
   detection-honest rows (assert against the fixture: no CLI installed →
   install row present with a copy chip); (c) seed a recent workspace →
   reopen → Recents card renders name/path/chips and clicking it opens
   the workspace (existing open-service path); (d) dismiss the checklist
   → it never returns across a reopen (persisted); (e) spacing: hero →
   grid gap ≥ `--sp-6`, card padding ≥ `--sp-4` (computed); (f)
   both themes AA on card text (Phase-5 probe). Verdict
   `out/homeux-result.json`.

## Files
- `src/ui/features/home/index.ts` · `home/firstrun.ts` · home CSS block
  on tokens · `src/main/homeux-smoke.ts` · main dispatch · qa-smokes.sh
  row · gallery (both themes)

## Definition of Done
- Home reads as a designed landing: hero, carded recents, real empty
  state — zero bare lists.
- The checklist stays detection-honest and gains no duplicate promises;
  every superseded row links to the Phase-8 flow instead.
- FIRSTRUN + PRODUCT gates still green (they drive Home + checklist);
  HOMEUX green; count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION + MILESTONE re-run (renderer touched).

## Guardrails
- Detection honesty is the checklist's soul — restyle it, never fake a
  tick or pre-collapse a row the machine can't verify.
- Recents show basename + a shortened path; full paths stay out of
  telemetry as always (ADR 0005).
