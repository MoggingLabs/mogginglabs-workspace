# Phase 9 — Loops: the harness that keeps working after you stop

Sequenced task prompts for Phase 9 of **MoggingLabs Workspace**: everything the
app runs today is a SESSION — someone starts it, someone ends it. A **loop** is
a standing harness: a trigger fires (a schedule, a queued card, a Sentry error
spike), an iteration launches the user's own agent CLI in a fresh worktree pane,
an OBJECTIVE verify command judges the work, the existing review/merge gates
land it, and a staged playbook rewrite makes the next pass start sharper. The
references, each taken for its best organ: BridgeAgent's mission loop + Loops
board (design → ship → fix → rewrite ↻), the Karpathy Loop's discipline (one
objective metric, hard budget box), Ralph's fresh-context-per-iteration with
state in files + git, Sentry Seer's stop-points ("nothing merges without your
approval"), and Anthropic's long-running-agent harness (one item per pass,
progress files, budgets as the PRIMARY safety mechanism). Sourced receipts in
`RESEARCH.md`. Same format as `prompts/phase-1..8/` (each step self-contained +
pasteable as a `/goal`, < 4000 chars). Execute in order, after Phase 8.

> **Neutrality decision (made here, binding — extends ADR 0002)**: the loop is
> OURS, the intelligence is THEIRS. Loops orchestrate the user's own installed
> CLIs through the existing pane machinery; the app never ships an agent, never
> brokers auth, takes no cut. In smokes, every loop runs the deterministic
> shell provider — never a vendor CLI.

> **The loop laws (codified as ADR 0009 in step 01, binding on every step)**:
> 1. Fresh context per iteration — a NEW CLI session in a NEW worktree pane;
>    cross-iteration state lives in files + git, never in a conversation.
> 2. One work item per iteration.
> 3. Nothing lands without the verify gate green AND a sign-off (human review,
>    or the Phase-4 reviewer gate when deputized) — autoland is a per-loop
>    typed opt-in stacked ON TOP of both, never a default.
> 4. Budgets (iterations, wall-clock, quota pace) are mandatory and enforced
>    by the ENGINE, not the prompt. A spec without budgets refuses to save.
> 5. Loop, mission, and issue content never enter telemetry (ADR 0005) —
>    counts and booleans only.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-loop-core-and-adr.md` | ADR 0009 + `@contracts/loops` + engine state machine on FAKE parts; LOOPS smoke green, zero network |
| 02 | `02-iteration-runner.md` | Worktree-pane iterations + verify runner + bounded retry-with-feedback; LOOPITER smoke green on isolated temp repo |
| 03 | `03-triggers-budgets-pace.md` | Trigger seam (manual/schedule/queue/watcher) + budget enforcement + pace-guard + stall detection; LOOPTRIG smoke green |
| 04 | `04-sentry-watcher.md` | BYOK Sentry watcher on the Phase-8 service-adapter seam, FAKE fixtures: qualifying issues become deduped missions; LOOPWATCH smoke green, zero network |
| 05 | `05-gates-and-landing.md` | Stop-points + reviewer-gate landing + branch/PR handoff + house notifications; LOOPGATE smoke green |
| 06 | `06-learn-step.md` | Staged playbook rewrite reviewed like any diff; LOOPLEARN smoke green |
| 07 | `07-loops-milestone.md` | Loops view (rings, glyphs, ledger) + docs/15-loops.md + full 3-OS sweep + LOOPSMILESTONE end-to-end; pack freeze |

## Overall Definition of Done
- A loop defined once keeps a repo healthy without babysitting: FAKE Sentry
  fixture event → mission → fresh-worktree iteration → verify green → gated
  land → staged playbook diff — the whole chain asserted by one milestone
  smoke on an isolated repo, zero network.
- Every iteration leaves receipts: branch, diff, verify output tail, verdict,
  wall-clock + iteration cost — inspectable in the ledger drill-in.
- A loop NEVER lands code silently: default stop-point is Review; reviewer
  gate and typed autoland compose exactly like Phase 3/4 merges.
- Quota-aware: when the Phase-7 pace verdict says run-out, loops pause (or
  fail over profiles, Phase-4 style) and say so — no other organizer does this.
- The full sweep — WITH the seven new gates — is green on all three CI OSes.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation; both
  perf budgets (MILESTONE + PERCEPTION) re-run after any renderer-touching step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **ADR 0002/0007/0009**: watcher tokens are the user's own, read at request
  time, held in memory for the one request, never persisted, logged, copied,
  or displayed. No OAuth flows, ever. Smokes run on FAKE fixtures exclusively.
- **ADR 0005**: mission text, issue titles, stack traces, playbook content —
  user content, never telemetry. Loop metrics are counts/booleans only.
- Daemon protocol stays v3 — loops live in the app backend and drive panes
  through EXISTING verbs; zero new wire surface.
- Poll politely (watchers): cadence presets, jittered, exponential backoff,
  paused when the app is hidden; dimmed-stale over hammering.
- Every loop is killable in one click and auto-pauses on repeated identical
  failures (the deterministically-bad Ralph morning is a PAUSED loop with
  receipts, not a surprise).

## Parallelization
01 → 02 → 03 is the spine. 04 rides the watcher contract from 01 + the queue
from 03. 05 needs 02; 06 needs 05. 07 freezes the pack. Two lanes after 03:
(05 → 06) and (04); merge at 07.
