The rewrite step is what makes a loop compound instead of repeat — and it is
exactly where self-improving agents go wrong (saved wrong assumptions poison
every later pass). So the learn step produces a STAGED DIFF a human reviews
like any other code: BridgeAgent's playbook idea, hermes' write-approval
staging, our review UX.

## Steps
1. **Playbook files, in-repo**: `.mogging/loops/<slug>/PLAYBOOK.md` (how this
   repo wants this loop's work done: build/test quirks, conventions, known
   traps — the Ralph `AGENT.md` role) and `FIX_PLAN.md` (priority-sorted
   backlog the loop maintains — the Ralph `@fix_plan.md` role). Created from
   templates at loop creation; referenced (not inlined) in every iteration
   prompt; committed like any file so they travel with the repo and diff like
   code.
2. **The learn iteration**: after a run reaches a terminal state (landed,
   paused-failing, killed-after-work), the engine emits `stage-learn`: one
   extra bounded iteration in the SAME worktree lineage whose prompt is the
   run's receipts (verify tails, retry signatures, review outcome) + "patch
   PLAYBOOK.md / FIX_PLAN.md with what this pass exposed — smallest useful
   edit, no restructuring". Its diff is confined to `.mogging/loops/<slug>/`
   — any file outside → the learn iteration is discarded with a receipt
   (enforced by path check on the diff, not by trust).
3. **Staging, never auto-apply**: the learn diff goes to the Review modal
   flagged `learn` (distinct chip), default stop-point `review` ALWAYS — the
   learn step ignores the loop's own stop-point; autoland never applies to
   playbook edits (a loop must not grant itself beliefs). Approve → the
   existing merge lands it on the loop's base branch; reject → recorded,
   receipts kept, next run unchanged.
4. **Poison brake**: if two consecutive learn diffs are rejected, stop
   emitting `stage-learn` for this loop until a human re-enables it in the
   spec (`learning: paused` chip on the loop card) — repeated rejected
   lessons mean the mission or verify needs a human, not more lessons.
5. **LOOPLEARN smoke** (`MOGGING_LOOPLEARN`, env-gated, isolated temp repo,
   shell provider): scripted run → learn iteration produces a diff touching
   only the playbook dir → staged, NOT merged; approve path lands exactly
   that diff; a fixture learn diff touching `src/` → discarded with receipt;
   two rejects → `learning: paused` persisted and no third `stage-learn`.
   Verdict via `out/looplearn-result.json`.

## Files
- `src/backend/features/loops/learn.ts` · playbook templates
  (`src/backend/features/loops/templates/`) · Review modal `learn` chip ·
  `src/main/looplearn-smoke.ts` · `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- LOOPLEARN green in the sweep on fresh isolated state.
- A rejected lesson is consequence-free (next run's prompt byte-identical);
  an approved lesson demonstrably reaches the next run's iteration prompt
  (smoke asserts the reference resolves to the new content).
- The path confinement is testable and tested — no learn diff can touch
  product code, ever.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate.

## Guardrails
- The learn step edits the PLAYBOOK, never the SPEC: missions, verify
  commands, budgets, stop-points stay human-owned (the agent may PROPOSE spec
  changes as prose inside PLAYBOOK.md; the app never applies them).
- Playbook content is user content (ADR 0005): local + in-repo only.
- One learn iteration per run, bounded like any iteration — learning cannot
  consume the budget the work needs.
- No global skill store in v1: lessons are per-loop, per-repo, reviewable.
  Cross-repo skill sharing is a later phase, deliberately (see RESEARCH.md on
  hermes staging + agentskills.io before designing it).
