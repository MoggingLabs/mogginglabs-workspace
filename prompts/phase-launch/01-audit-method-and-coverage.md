Part I starts at the METHOD, not the fixes. A launch audit that
isn't systematic is a vibe. Establish the inventory, the rubric, the
routing, and a coverage GATE — so "we checked everything" is provable,
not asserted. Zero product code changes this step: this builds the frame
02–07 fill.

## Steps
1. **Feature inventory** (`prompts/phase-launch/INVENTORY.md`): enumerate
   every user-facing feature and every load-bearing subsystem, one row
   each, grouped by the docs/02 phase that shipped it (terminal core,
   panes/layout, scroll, files, board, worktrees, swarm, usage,
   connections, integrations, browser, brain, account/entitlements,
   hardening, updater, control API/MCP, `mogging` CLI). Each row: a
   `file:line` entry point, the doc that specifies it, and the gate(s)
   that currently cover it. This is the denominator — if a surface isn't a
   row, it can't be audited.
2. **The rubric** (`prompts/phase-launch/RUBRIC.md`): the six lenses every
   row is graded on, each with a concrete definition and an example from
   THIS codebase — (a) *correctness/edge-cases* (empty, huge, concurrent,
   offline, malformed, cancel-mid-flight); (b) *code smell / anti-pattern*
   (god-objects, boolean-trap params, stringly-typed state); (c)
   *spaghetti* (control flow no one can trace, hidden coupling); (d)
   *duplication* (copy-paste helpers, parallel implementations); (e)
   *inefficiency* (redundant pollers, N², needless re-render/alloc); (f)
   *refactor debt* (oversized modules, dead affordances). Grades A–D; the
   floor is **B** (below-B must be fixed or deferred-with-rationale).
3. **The routing ledger** (`prompts/phase-launch/FINDINGS.md`): the append
   log every later step writes — `id · area · lens · file:line · severity
   (S1 ship-blocker … S3 nit) · verdict (fix|defer|wontfix) · rationale ·
   resolved-in`. A finding is never silently dropped; a defer names why.
4. **LAUNCHAUDIT static gate** (`scripts/check-launch-audit.mjs`, a new
   qa-smokes row): fails if any INVENTORY row is ungraded, any row grades
   below the floor without a `defer`/`wontfix` + rationale in FINDINGS, or
   any FINDINGS entry is `open` with no verdict. Mirror the
   `scripts/check-audit.mjs` design (phase-8.5's coverage gate) — pure
   file parse, zero app boot. Verdict `out/launchaudit-result.json`.
5. **Wire it**: add the row to `scripts/qa-smokes.sh`, register in the
   static battery, and seed INVENTORY with the full row list (grades
   blank — 02–07 fill them). `check-gate-count.mjs` re-derives; write what
   it prints.

## Files
- `prompts/phase-launch/INVENTORY.md` · `RUBRIC.md` · `FINDINGS.md` ·
  `scripts/check-launch-audit.mjs` · `scripts/qa-smokes.sh` ·
  `prompts/phase-launch/CHECKLIST.md` (mark 01 items)

## Definition of Done
- LAUNCHAUDIT green (with the seeded, still-ungraded inventory it fails
  loudly until 02–07 grade the rows — verify it BITES by leaving one row
  blank and seeing red, then seed-comment it as intentionally-pending).
- INVENTORY covers every feature in docs/02 + the accounts/brain packs; no
  subsystem without a row (cross-check against `qa-smokes.sh` gate list).
- RUBRIC's six lenses each carry a real in-repo example.

## Checks that must be green
- `npm run typecheck` → 0; build ok; the static battery (AUDIT · SPACING ·
  PTYSEAM · PROTOVER · CHANNELS · gate-count); LAUNCHAUDIT in isolation.

## Guardrails
- No product code touched — method + ledger + gate only.
- The gate parses files; it never boots the app or reaches the network.
- The floor is B and it is enforced by the gate, not by good intentions.
