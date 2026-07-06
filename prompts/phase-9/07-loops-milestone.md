Freeze the pack the house way: give loops their face (the Loops view), write
the book (docs/15-loops.md), and prove the whole promise in ONE end-to-end
milestone smoke on all three CI OSes — a fixture error becomes landed, gated,
learned-from code with zero network and zero vendor CLIs.

## Steps
1. **Loops view** (`src/ui/features/loops/`): a top-level view beside Board
   (palette + `Ctrl+Shift+L`). Each loop = a card: name, provider+profile
   chip, trigger origin chip, progress ring (iteration n / budget), state
   glyph per `LoopState` (distinct `stalled` and `paused-quota` treatments;
   house tokens), last verdict line, next-fire countdown for schedules, `learning: paused` chip
   when 06 tripped. Actions: Run now · Pause · Kill · Open pane ·
   Open ledger. Non-running loops restartable in one click.
2. **Ledger drill-in**: runs (origin, state, wall-clock) → iterations
   (branch, verdict, verify tail, receipts) → landing record (sign-off,
   merge sha / PR url) → learn outcome. Every claim the loop makes about
   itself is clickable down to a receipt. Both themes, gallery states staged
   for: idle, iterating, awaiting-review, paused-quota, stalled, killed.
3. **docs/15-loops.md**: the loop laws, the state machine diagram, a
   worked example (the Sentry fix loop end-to-end), stop-points table,
   budget + pace-guard semantics, playbook file format, and the scripted
   demo (only `mogging …` + the app). Update `docs/02-mvp-and-roadmap.md` +
   the README roadmap line; RESEARCH.md stays the sourced record.
4. **`MOGGING_LOOPSMILESTONE`** (env-gated, isolated temp repo + fresh app
   state, shell provider, fake timers, zero network): the full chain in one
   smoke — FAKE Sentry fixture → exactly one mission card → scheduled
   trigger fires → fresh-worktree iteration (scripted agent commits a fix)
   → verify red once → retry-with-feedback → green → `awaiting-review` with
   provenance → reviewer-gate sign-off → autoland spec variant lands
   `--no-ff` → learn diff staged and approved → second poll of the same
   fixture creates NOTHING (dedupe) → budgets: a variant spec exhausts at
   2 iterations → `paused-budget`; pace run-out fixture → `paused-quota`.
   Assert: repo HEAD advanced exactly by the merges, planted fake token
   absent from every artifact, all receipts present. Verdict via
   `out/loopsmilestone-result.json`.
5. **Sweep + freeze**: wire all seven gates into `scripts/qa-smokes.sh` docs
   + CI (three OS sweeps); re-run MILESTONE + PERCEPTION budgets with a live
   loop iterating among 12 panes — budgets UNCHANGED; record per-OS numbers;
   freeze `prompts/phase-9/` (errata via REPORT.md).

## Files
- `src/ui/features/loops/` · `src/main/loopsmilestone-smoke.ts` ·
  `docs/15-loops.md` · roadmap/README touch-ups · `scripts/qa-smokes.sh` +
  CI workflow gate rows

## Definition of Done
- All three CI OSes green on the FULL sweep including LOOPS, LOOPITER,
  LOOPTRIG, LOOPWATCH, LOOPGATE, LOOPLEARN, LOOPSMILESTONE.
- One glance at the Loops view answers: what is running, what needs me, what
  is paused and WHY (budget / quota / failing / stalled — distinct at a
  glance).
- The scripted demo in docs/15 works on a fresh machine exactly as written.
- Perf budgets hold with a loop live: worst gap ≤ 150 ms, avg fps ≥ 30,
  heap ≤ 300 MB, 12 live panes.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean; both perf
  budgets; full sweep, three OSes.

## Guardrails
- The milestone smoke is the ONLY authority on "Phase 9 done" — no partial
  credit, no gate skipped on any OS.
- Gallery states for every new visual, both themes, AA-measured against the
  Phase-5 token system.
- No new daemon wire surface slipped in anywhere (grep the protocol — still
  v3).
- ADR 0005 sweep before freeze: grep telemetry calls for loop/mission/issue
  strings — counts and booleans only.
