Part I starts at the METHOD, not the fixes: an audit that isn't
systematic is a vibe. Establish the inventory, the rubric, the routing,
and a coverage GATE — so "we checked everything" is provable, not
asserted. Zero product code: this builds the frame 02–07 fill.

## Steps
1. **Feature inventory** (`INVENTORY.md`): enumerate every user-facing
   feature and every load-bearing subsystem, one row each, grouped by the
   docs/02 phase that shipped it (terminal core, panes/layout, scroll,
   files, board, worktrees, swarm, usage, connections, integrations,
   browser, brain, account/entitlements, hardening, updater, control
   API/MCP, `mogging` CLI). Each row: a `file:line` entry point, the doc
   that specifies it, the gate(s) covering it. The denominator — if a
   surface isn't a row, it can't be audited.
2. **The rubric** (`RUBRIC.md`): six lenses, each an OBJECTIVE TRIGGER +
   in-repo example — (a) *correctness* (an enumerated edge case — empty,
   huge, concurrent, offline, malformed, cancel-mid-flight — with a wrong
   or silent outcome); (b) *smell* (a named anti-pattern: god-object,
   boolean-trap param, stringly-typed state); (c) *spaghetti* (untraceable
   control flow, hidden coupling); (d) *duplication* (two helpers, same
   AST shape, different homes); (e) *inefficiency* (a poller with no
   idle-proof, a measured N², needless re-render/alloc); (f) *refactor
   debt* (a module past its stated LOC budget, an unreferenced export, a
   dead affordance). **A finding is a defect or a violation of a stated
   rule — never a preference.** "I'd have named it differently" is not
   fileable: that boundary is what makes must-fix terminate.
3. **Grades DERIVE from the ledger** (`FINDINGS.md`: `id · area · lens ·
   file:line · severity (S1…S3) · verdict · evidence · resolved-in`).
   Floor **A**, where **A ≡ zero open findings on that lens for that
   row** — the gate computes it, nobody types a letter. **Every finding
   is must-fix**: two verdicts only, `fixed` (regression assertion red on
   pre-fix bytes) and `invalid` (the claimed behavior does not reproduce,
   DISPROVEN, never merely argued). `defer`/`wontfix` are deleted;
   severity ORDERS the queue, it never decides whether to fix.
4. **LAUNCHAUDIT static gate** (`scripts/check-launch-audit.mjs`, a new
   qa-smokes row): fails if any INVENTORY row has an ungraded lens, any
   lens derives below A (an unresolved finding exists), or any FINDINGS
   row carries `open`/`defer`/`wontfix`. Mirror `scripts/check-audit.mjs`
   (phase-8.5's) — pure file parse, zero boot. Verdict
   `out/launchaudit-result.json`.
5. **Wire it**: add the row to `scripts/qa-smokes.sh`, register in the
   static battery, seed INVENTORY with the full row list (lenses blank —
   02–07 fill them). `check-gate-count.mjs` re-derives; write what it
   prints.

## Files
- `prompts/phase-launch/`: `INVENTORY.md` · `RUBRIC.md` · `FINDINGS.md` ·
  `CHECKLIST.md` (mark 01) · `scripts/check-launch-audit.mjs` ·
  `scripts/qa-smokes.sh`

## Definition of Done
- LAUNCHAUDIT wired and BITE-proven: one blank lens reds it; seed-comment
  the still-pending rows so 02–07 can fill them.
- INVENTORY covers every feature in docs/02 + the accounts/brain packs; no
  subsystem without a row (cross-check `qa-smokes.sh`).
- RUBRIC's lenses each carry an objective trigger + in-repo example; the
  not-a-finding boundary is written down.

## Checks that must be green
- `npm run typecheck` → 0; build ok; the static battery (AUDIT · SPACING ·
  PTYSEAM · PROTOVER · CHANNELS · gate-count); LAUNCHAUDIT in isolation.

## Guardrails
- No product code touched — method + ledger + gate only.
- The gate parses files; it never boots the app or reaches the network.
- A rule that proves wrong is amended in RUBRIC (visibly, for EVERY row);
  never waived for one instance. No silent drops.
