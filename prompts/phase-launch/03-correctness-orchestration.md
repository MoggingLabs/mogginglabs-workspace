The second correctness sweep: orchestration — the machinery that makes
sixteen agents safe. This is where OUR product creates the failure modes
(concurrency, ownership, merges), so the edge cases are the point. Same
rubric, same route-and-prove discipline as 02.

## Scope (INVENTORY rows for this step)
The board + card→pane launch + queueing, worktree-per-agent isolation
(`worktrees.ts`) + the pre-ship diff review + guarded `merge --no-ff`, the
swarm (mailbox `mogging mail`, roles, exclusive ownership
`claim/release/owners`, the reviewer `approve` gate), the control API
(`list/send/send-key/capture/open/layout/focus/expand/close-pane` over the
authed socket + deep-link relay), and Phase-9 loops IF present on main.

## Steps
1. **Enumerate the concurrency + failure edges** per row: two agents claim
   the same file; a merge with a secret in the diff (redaction holds); a
   merge conflict mid-`--no-ff`; a worktree left dirty on crash; a card
   launched into a full grid; `send` to a dead pane; a deep-link with a
   forged/oversized payload; the socket token missing/expired; a role
   count at the per-workspace cap; approve without a reviewer; a queue
   that must spawn on pane-free. Malformed/concurrent/cancel is the spine.
2. **Verify against the code** (`file:line`) and assert the guarantee in
   the owning gate — ORCHESTRATION, SWARMMILESTONE, BOARDV2, BOARDQUEUE,
   the control-API/MCP family — or a focused unit. Prove ledger denial,
   the mailbox handshake, territory commits, and the gated+overridden
   merge each still bite.
3. **Route findings** to FINDINGS with severity; S1/S2 fixed here (a lost
   claim, a merge that leaks, a queue that double-spawns are all S1), S3
   deferred with rationale.
4. **Grade** the rows ≥ B or defer; **re-measure** both budgets with the
   swarm up if any renderer/daemon path moved.

## Files
- `INVENTORY.md` (grades) · `FINDINGS.md` (routing) · the orchestration/
  swarm smokes + units extended · product files fixed · `CHECKLIST.md`
  (mark 03 areas)

## Definition of Done
- Every scoped row graded ≥ B (or deferred); every S1/S2 fixed with a
  bite-proven regression assertion (red on pre-fix bytes).
- The custody/ownership invariants (no claim lost, no unredacted merge, no
  double-spawn, no unauthed control verb) each carry an assertion.
- FINDINGS has no `open` row for this scope; gates + both budgets green.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; LAUNCHAUDIT; the
  orchestration/swarm/control gates in isolation; MILESTONE + PERCEPTION
  if a live path moved.

## Guardrails
- The reviewer gate and secret redaction are ship-blockers — any hole here
  is S1, no exceptions.
- `approve` is never a tool; `send` never presses Enter for the human —
  don't "fix" a finding by crossing those lines.
- Zero network; daemon protocol number unchanged; control socket stays
  off TCP (ADR 0008(b)).
