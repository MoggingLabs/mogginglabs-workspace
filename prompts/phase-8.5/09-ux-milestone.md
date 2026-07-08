The UX milestone + freeze (Phase-8.5/09). The pack's proof: one composed
smoke asserting the revamp HOLDS as a system (spacing tokens everywhere,
one page-wizard flow end-to-end, disclosure states, safety surfaces
undimmed) with both perf budgets unchanged — then gallery, books, and the
four-environment certification that freezes the pack.

## Steps
1. **UXMILESTONE smoke** (`MOGGING_UXMILESTONE`, env-gated, qa-smokes.sh)
   — one fixture world, no network, asserting the composed story:
   (a) fresh boot → Home hero + checklist card (06) → wizard opens as ONE
   page (02), a folder picked by CLICKS through the browser (03), agents
   quick-filled, launch → workspace opens with the mix;
   (b) Settings: shell frame + grouped nav (04), both dense tabs open to
   overview-first with persisted disclosure (05), every legacy DOM hook
   the older gates click still resolves;
   (c) board + palette + a toast + a confirm render the one feedback
   family (07); chrome: pane header single-line with fixture chips,
   tabs overflow cleanly (08);
   (d) **the spacing grep, structural**: walk the stylesheet for feature
   blocks touched by this pack and assert no hardcoded px
   margin/padding remains outside the token scale (the 01 § Enforcement
   grep, now a gate);
   (e) **safety undimmed**: possession banner, consent copy, attention
   states, and the trail's "never sent anywhere" line all render at
   their pre-pack prominence (class/visibility asserts);
   (f) budgets sampled DURING the composed surface (Home → wizard →
   workspace → Settings → board open) — frame gaps, fps, heap against
   the UNCHANGED docs/05 numbers.
   Verdict `out/uxmilestone-result.json`.
2. **Gallery restage**: every surface this pack touched, both themes —
   wizard, folder browser, Settings (shell + both dense tabs), Home,
   board, palette, toasts, chrome. The gallery carries the visuals; the
   books carry numbers only.
3. **Books**: README status + roadmap row for 8.5; `docs/02` section;
   `prompts/README.md` row; docs/11 (design system) gains the spacing
   scale + primitives section; AUDIT.md gets a DONE column (every
   keep/fix/remove verdict resolved or explicitly deferred with reason).
   Gate counts COUNTED anew from qa-smokes.sh everywhere they're stated.
4. **Four-environment certification**: ONE dispatch, full uncut sweeps —
   all pack gates (WIZARDUX, FOLDERPICK, SETSHELL, SETTABS, HOMEUX,
   BOARDUX, CHROMEUX, UXMILESTONE) + all pre-existing gates green on
   local Windows AND the three CI OSes. Per-OS numbers + run id in the
   pack README; platform finds get root causes; REPORT.md if earned.
5. **Pack freeze**: DONE rows, commit ranges + run ids in the pack
   README; the phase-9 pointer verified.

## Files
- `src/main/uxmilestone-smoke.ts` · qa-smokes.sh · gallery ·
  `README.md` · `docs/02` · `docs/11` · `prompts/README.md` ·
  `prompts/phase-8.5/README.md` + `AUDIT.md` · REPORT.md

## Definition of Done
- UXMILESTONE green inside the full sweep on all four environments;
  budgets unchanged with the whole revamp on.
- AUDIT.md fully resolved — no verdict left dangling.
- Every book stating a gate count states it anew; the design-system doc
  teaches the spacing scale.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full sweep on all four environments, every gate; nightly crons left
  enabled.

## Guardrails
- Asserts EXISTING pack behavior composed — new product code here means
  an earlier step was incomplete; fix there, stay assertion-only.
- Budgets are the freeze criterion: a revamp that moved docs/05 numbers
  is not done, it's regressed.
- No screenshots-as-proof: books cite smoke output and run ids; the
  gallery carries the visuals.
