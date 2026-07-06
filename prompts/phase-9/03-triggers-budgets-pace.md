A loop without a trigger is a button; a loop without budgets is a bill. Put
every way a loop can start behind ONE seam, and every way it must STOP behind
engine-enforced budgets — including the one no rival has: the Phase-7 pace
verdict pausing loops BEFORE the quota wall.

## Steps
1. **Trigger seam** (`@backend/features/loops/triggers/`): one interface,
   four sources, all emitting the same `LoopEvent { loopId, mission, origin }`
   into the engine:
   - **Manual** — "Run now" (IPC verb), mission = spec template.
   - **Schedule** — interval presets (15m · 1h · 6h · daily), jittered ±10%,
     skipped while a run is live (no pile-ups), paused while the app is
     hidden; timers live in the host, never the reducer.
   - **Queue** — a designated Board column (default: a new "Loop" column on
     the existing Kanban): each card = one mission; the loop drains it
     oldest-first, one card per run; card binds to the run like Phase-3 cards
     bind to panes (moves Doing → Review with it).
   - **Watcher** — the `LoopWatcher` contract from 01; this step ships only
     the FAKE watcher (fixture-fed). Real adapters are step 04's job.
2. **Budget enforcement in the host**: `maxIterations` and `maxWallClockMs`
   checked before EVERY `launch-iteration` effect; exhaustion →
   `paused-budget` + house notify with receipts ("iteration 6/6 — budget").
   Anthropic's stance, verbatim in a code comment: budgets are the primary
   safety mechanism, not the completion promise.
3. **Pace-guard**: subscribe to the Phase-7 pace engine for the spec's
   provider+profile. Verdict = run-out → finish the CURRENT iteration, then
   `paused-quota` with the run-out ETA in the notify; offer the Phase-4 verb:
   "Relaunch loop on <next profile>" (one hop per event, same rules as pane
   failover). Verdict recovers (reset passed / surplus) → auto-arm again,
   stated in the ledger.
4. **Stall detection**: a run in `iterating` whose pane emits no OSC
   transition for the spec's stall-window (default 10m) → `stalled` (distinct
   glyph, BridgeAgent parity), notify, offer restart-iteration / kill. Restart
   discards the stalled pane, keeps the branch, increments the iteration
   counter (a stall is not free).
5. **LOOPTRIG smoke** (`MOGGING_LOOPTRIG`, env-gated, fake timers): schedule
   fires with jitter inside bounds + skips while live; queue drains two cards
   across two runs oldest-first; budget exhaustion at the exact iteration
   count; pace run-out fixture → `paused-quota` after the in-flight iteration
   completes, then auto-rearm on a surplus fixture; stall fixture → `stalled`.
   Verdict via `out/looptrig-result.json`.

## Files
- `src/backend/features/loops/triggers/` (seam + manual/schedule/queue/fake
  watcher) · pace subscription in `src/backend/features/loops/host.ts` ·
  Board column wiring · `src/main/looptrig-smoke.ts` ·
  `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- LOOPTRIG green in the sweep on fresh isolated state.
- All four trigger origins visibly labeled in the ledger (`origin` on every
  run) — a run always answers "why did this start?".
- Pace-guard demonstrably prevents a run-out: the smoke proves no iteration
  launches while the verdict says run-out.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the new gate.

## Guardrails
- One live run per loop, ever — triggers queue, they never parallelize a
  single loop (parallelism = multiple loops, each in its own worktree).
- Card text stays local (ADR 0005): queue missions never enter telemetry,
  notify payloads, or logs.
- Timers are host-side and injectable; the reducer stays pure (01's law).
- No trigger may bypass budgets — including Manual "Run now".
