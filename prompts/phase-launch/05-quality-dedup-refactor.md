Correctness proved (02–04); now make the code CLEAN. Kill duplication,
delete the dead, decompose the oversized, straighten the spaghetti — and
pin each win with a GATE so the debt can't creep back. This step changes
structure, never behavior: every existing gate is the safety net, green
before and after.

## Steps
1. **Duplication hunt**: find copy-pasted helpers and parallel
   implementations of one idea (formatters, path/identity helpers, refusal
   grammars, OSC/ANSI handling, git parsing, token/vault access shapes).
   For each, extract ONE home and route callers through it — the
   board-identity extraction (brain step-01) is the model: bytes identical
   after. Record each merge in FINDINGS with the before/after `file:line`.
2. **Dead-code sweep**: unreferenced exports, unreachable branches, retired
   affordances left as commented code, feature flags that no longer flip,
   TODO scaffolds. **Delete, don't hide** (the phase-8.5 rule — 13 real
   removals). Confirm via typecheck + a reference check that nothing lives.
3. **Refactor the oversized**: modules past a size/complexity budget or
   with untraceable control flow (TerminalPane's history is the cautionary
   tale). Decompose along real seams (the composition-root/port idiom, ADR
   0004); no new deps (ADR 0004 — a positioner is a rect clamp, not
   floating-ui). Behavior identical — the gates prove it.
4. **MAINT static gate** (`scripts/check-maintainability.mjs`, new
   qa-smokes row): fails on (a) a duplicate-helper signature reappearing,
   (b) an unreferenced export in `src/` (allowlist the intentional), (c) a
   module over the LOC budget without a `// maint:allow <reason>`. Pure
   AST/parse, zero boot. Verdict `out/maint-result.json`.
5. **Re-measure** both budgets if any hot path was decomposed; a refactor
   that costs frame time is reverted, not shipped.

## Files
- `scripts/check-maintainability.mjs` · `scripts/qa-smokes.sh` · the
  extracted/deleted/decomposed product files · `FINDINGS.md` (each change)
  · `INVENTORY.md` (grades rise) · `CHECKLIST.md` (mark 05)

## Definition of Done
- MAINT green and bite-proven (re-introduce one duplicate → red; delete →
  green).
- Every extraction leaves the caller's behavior byte-identical, proven by
  the unchanged gates; every deletion confirmed unreferenced.
- No new runtime dependency added; SPACING `--max 0` still frozen.
- FINDINGS records every structural change with before/after locations.

## Checks that must be green
- `npm run typecheck` → 0; `npm run lint` → 0; build ok; static battery +
  MAINT; the FULL set of gates touching any refactored file, in isolation;
  MILESTONE + PERCEPTION if a hot path moved.

## Guardrails
- Structure-only — if a diff changes behavior it belongs in 02–04, not
  here; keep them separate so a regression is bisectable.
- Delete beats deprecate; a kept-for-later export earns an allowlist entry
  with a reason, not silence.
- No dependency added to "simplify"; the house writes it in vanilla TS.
