The UX milestone + freeze (Phase-8.5/09). One composed smoke asserting the revamp
HOLDS as a system, budgets unchanged — then gallery, books, and the four-environment
certification that freezes the pack. **Nothing is done until AUDIT.md has no row
below A and no unrouted finding.**

## Steps
1. **UXMILESTONE smoke** (`MOGGING_UXMILESTONE`, env-gated) — one fixture world, no
   network, the composed story:
   (a) fresh boot → Home hero + checklist card (06) → wizard opens as ONE page (02),
   a folder picked by CLICKS through the browser (03), launch → workspace opens;
   (b) Settings: shell + grouped nav (04); Integrations (05) and Usage (05b) open
   overview-first with persisted disclosure, and a seeded attention chip shows
   through a COLLAPSED header; every legacy DOM hook still resolves;
   (c) board + palette (07) and one feedback family — a destructive confirm focuses
   the safe action (07b); chrome: a single-line pane header, tabs overflow cleanly
   (08), the possession banner unmissable (08b);
   (d) **the spacing gate**: `check-spacing.mjs --max 0` — every bucket zero,
   including the `—` shared row (01 shipped a broken awk that over-counted 33 as 94);
   (e) **safety undimmed**: possession banner, consent copy, attention states, the
   review-gate indicator and the trail's "never sent anywhere" line render at their
   pre-pack prominence, AA-measured via `aa-probe.ts`;
   (f) budgets sampled DURING the composed surface against the UNCHANGED docs/05
   numbers. Verdict `out/uxmilestone-result.json`.
2. **The coverage gate — assertion, not vibes.** `scripts/check-audit.mjs` parses
   AUDIT.md and FAILS if: any Grades row is below **A**; any REMOVE row lacks ✅;
   any § Bugs entry lacks an owner + resolution; either § Blocker is undischarged;
   any § Deviation is unresolved. Run it in the sweep. It is what stops a surface
   going unowned again — it is how 05b was found.
3. **Gallery restage**: every surface the pack touched, both themes. The gallery
   carries visuals; the books carry numbers only.
4. **Books**: README status + roadmap row for 8.5; `docs/02`; `prompts/README.md`;
   `docs/11` gains the spacing scale, the primitives, the radius decision (08) and
   the AA-probe provenance; AUDIT.md gets its DONE column. Gate counts COUNTED anew
   from qa-smokes.sh wherever they are stated.
5. **Four-environment certification**: ONE dispatch, full uncut sweeps — every pack
   gate (WIZARDUX, FOLDERPICK, SETSHELL, SETINTEG, SETUSAGE, HOMEUX, BOARDUX,
   FEEDBACKUX, CHROMEUX, DOCKUX, UXMILESTONE) + all pre-existing gates green on
   local Windows AND the three CI OSes. Per-OS numbers + run id in the pack README;
   platform finds get root causes; REPORT.md if earned.
6. **Pack freeze**: DONE rows, commit ranges + run ids in the pack README; the
   phase-9 pointer verified.

## Files
- `uxmilestone-smoke.ts` · `scripts/check-audit.mjs` · qa-smokes.sh · gallery ·
  `README.md` · `docs/02` · `docs/11` · `prompts/README.md` ·
  `prompts/phase-8.5/README.md` + `AUDIT.md` · REPORT.md

## Definition of Done
- UXMILESTONE green in the full sweep on all four environments; budgets unchanged.
- `check-audit.mjs` green: **every Grades row A**, every REMOVE ✅, every bug owned
  + resolved, both Blockers discharged, every Deviation resolved.
- `check-spacing.mjs --max 0`.
- Every book stating a gate count states it anew; docs/11 teaches the system.

## Checks that must be green
- typecheck 0; build ok; boundaries clean.
- Full sweep on four environments, every gate; nightly crons enabled.

## Guardrails
- Asserts EXISTING pack behavior composed — new product code here means an earlier
  step was incomplete; fix there. (`check-audit.mjs` and the milestone smoke are
  the two sanctioned new files.)
- Budgets are the freeze criterion: a revamp that moved docs/05 is regressed.
- No screenshots-as-proof: books cite smoke output and run ids.
