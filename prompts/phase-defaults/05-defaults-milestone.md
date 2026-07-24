Freeze the phase: write the book, then prove the whole promise in ONE composed run on a
FAKE provider with zero network — the single authority on "phase-defaults done".

## Steps
1. **The book** (`docs/22-shared-defaults.md`): the resolution law (`pin ?? default ?? file`), the
   cascade position (`session > project > local > pin > account-default > file > system`), the
   three doctrines (shared-by-default, primary-home-is-a-full-member, ADR-0002-non-secret), the
   lifecycle (propagate / adopt / restore / reset), and the UX contract (Applies-to, Reset,
   promote, first-write consent). Link ADR 0022, ADR 0011, ADR 0013. State the honest limit: this
   enforces sameness through the app's own writer — a CLI edited entirely outside the app between
   reconcile ticks is transiently divergent until the next tick.
2. **Composed milestone** (`MOGGING_DEFAULTSMILESTONE`, `src/main/smokes/defaultsmilestone-smoke.ts`):
   isolated boot, one FAKE provider, three homes (two pointer + the primary/user home), zero network.
   Assert, as one story of booleans:
   - set a default S=X → all three homes carry X (primary INCLUDED);
   - pin profile A S=Y → home A = Y, the other two = X;
   - change the default X→Z → the two unpinned homes = Z, home A still = Y;
   - add a fourth account → it adopts Z on the profiles-changed signal;
   - hand-edit a home's file off Z → next reconcile restores Z;
   - clear A's pin → home A re-inherits Z;
   - a secret-shaped default value is REFUSED at save;
   - no setting value appears in the result JSON (IDs/booleans only).
3. **Sweep + docs wiring**: register the milestone in `scripts/qa-smokes.sh`; `check-gate-count.mjs`
   +1 (the pack's fourth and final gate); add the phase to the roadmap/README index the other phases
   use; a `REPORT.md` with the measured booleans and any platform finds.

## Files
- `docs/22-shared-defaults.md` · roadmap/index entry · `prompts/phase-defaults/REPORT.md`
- `src/main/smokes/defaultsmilestone-smoke.ts` · `scripts/qa-smokes.sh` · `scripts/check-gate-count.mjs`

## Definition of Done
- `docs/22-shared-defaults.md` is the book; `MOGGING_DEFAULTSMILESTONE` composes set → pin → change →
  adopt → drift-restore → reset → deny-secret in one green run on FAKE, zero network, primary home a
  full member throughout.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; all four pack gates green isolated (DEFAULTSTORE ·
  PROFILEDEFAULTS · DEFAULTSUX · DEFAULTSMILESTONE); `MOGGING_AGENTSETTINGS` + `MOGGING_PROFILES` green.
- MILESTONE + PERCEPTION unchanged; gate-count check passes with the final total.
- Grep-clean: no secret or setting value in any `out/*-result.json`.

## Guardrails
- The milestone is the ONLY authority on "phase-defaults done" — every claim above is a bite in it,
  each independently reproducible via `MOGGING_GATES=<GATE> bash scripts/qa-smokes.sh`.
- FAKE-first, zero network — no real provider account or home is ever touched by a gate.
- ADR 0002 sweep before freeze — no provider credential anywhere in the tier; defaults are non-secret.
- No perf regression — the composed surface re-measures both budgets; the fan-out stays async/post-paint.
