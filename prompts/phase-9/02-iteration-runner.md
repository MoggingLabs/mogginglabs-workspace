An iteration is Phase 3's card→agent flow, run by a machine instead of a
click. Wire the engine's `launch-iteration` and `run-verify` effects to the
REAL pane machinery: fresh worktree pane, mission as first prompt, completion
detected by events, then an objective verify command whose exit code — not the
agent's self-report — is the verdict.

## Steps
1. **Launch** (`@backend/features/loops/runner.ts`): on `launch-iteration`,
   reuse the Phase-3 launcher verbatim: 1-pane workspace at `workspaceRoot`,
   own worktree on `mogging/loop-<slug>-<n>` (random slug — mission text never
   becomes a path), provider + profile from the spec (Phase-4 pointer sets;
   usage-limit failover applies unchanged). First prompt = mission text +
   playbook file reference + the iteration contract: "one work item, commit
   with a descriptive message, run nothing destructive, signal done".
2. **Completion detection, event-driven**: an iteration ends when (a) agent
   hooks fire `mogging notify --event loop-done` (extend the Phase-2 hook set
   with this ONE event name — additive, still exit-0-always), or (b) the
   pane's OSC state sits idle past the spec's quiet-window, or (c) the pane
   dies. No transcript parsing — states and events only, zero polling beyond
   the existing OSC machinery.
3. **Verify runner**: run the spec's `verify.cmd[]` sequentially IN the
   worktree (spawned directly, not typed into the pane; cwd = worktree, env
   scrubbed to a documented allowlist, timeout enforced). Exit 0 for all →
   `green`; else `red` with the last 200 lines of combined output captured as
   the receipt. The agent's opinion of its own work is never consulted —
   Karpathy's law: the metric is the judge.
4. **Bounded retry-with-feedback**: on `red`, if the run's iteration budget
   allows, the next iteration's prompt = mission + verify failure tail +
   "fix ONLY this". Three consecutive identical-signature failures (hash of
   verify tail) → `paused-failing` (engine already models it) + house notify.
   Never reset the worktree silently; the branch and its receipts survive for
   the human.
5. **Receipts**: per iteration persist branch name, HEAD sha, files-touched
   count, verify verdict + output tail, wall-clock. Receipts are user content
   (ADR 0005) — ledger only, never telemetry.
6. **LOOPITER smoke** (`MOGGING_LOOPITER`, env-gated): on an isolated temp
   repo with the deterministic shell provider: green path (scripted "agent"
   commits a fix, verify passes) → iteration recorded green, worktree branch
   exists, repo HEAD untouched; red path (verify fails 3×) → `paused-failing`,
   receipts show the tail; kill mid-iteration → pane closed, worktree intact,
   state `killed`. Verdict via `out/loopiter-result.json`.

## Files
- `src/backend/features/loops/runner.ts` (+ verify.ts) ·
  `hooks/` (loop-done event) · `src/main/loopiter-smoke.ts` ·
  `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- LOOPITER green in the sweep on fresh isolated state.
- A loop iteration is indistinguishable from a Phase-3 card launch in the
  pane UI (same chrome, same review affordances) — no parallel machinery.
- Repo HEAD/index byte-identical after any iteration (same assertion the
  WORKTREE smoke uses).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate; MILESTONE perf budget re-run
  (iterations add panes).

## Guardrails
- Fresh pane + fresh CLI session EVERY iteration (loop law 1) — never reuse a
  conversation; cross-iteration memory is the repo + playbook only.
- Verify commands come from the SPEC the human wrote — never synthesized by
  the agent, never edited by the learn step.
- One work item per iteration (loop law 2) is prompt-enforced AND
  budget-enforced; the runner never batches missions.
- Shell provider only in smokes; no vendor CLI output shapes asserted.
