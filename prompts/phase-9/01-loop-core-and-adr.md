Loops start at the LAWS, not the UI. Codify the loop laws as an ADR, cut the
contracts, and build the engine as a pure, event-driven state machine that runs
entirely on FAKE parts — so every later step (panes, triggers, watchers, gates)
plugs into a core that is already smoke-proven with zero network.

## Steps
1. **ADR 0009 — loops are a deterministic harness** (`docs/adr/`): the five
   loop laws verbatim from the pack README (fresh context per iteration; one
   work item per iteration; verify-green + sign-off before landing, autoland
   as typed per-loop opt-in on top; engine-enforced mandatory budgets; loop
   content never in telemetry). Record the research lineage in one
   paragraph (organs + sources: RESEARCH.md). Explicitly forbid: the app shipping
   or brokering an agent (ADR 0002), auto-merge without the Phase-4 gate, a
   LoopSpec persisted without budgets.
2. **Contracts** (`@contracts/loops`): `LoopSpec { id, name, workspaceRoot,
   provider+profileId, trigger: Manual|Schedule|Queue|Watcher, mission
   (template), verify: { cmd, timeoutMs }[], budgets: { maxIterations,
   maxWallClockMs, pauseOnPaceRunOut }, stopPoint: 'plan'|'review'|'pr'|
   'autoland', playbookPath }, `LoopRun`, `LoopIteration { branch, verdict:
   'green'|'red'|'skipped', receipts }`, `LoopState` closed union: `idle |
   armed | iterating | verifying | awaiting-review | landing | learning |
   paused-budget | paused-quota | paused-failing | stalled | killed`, plus the
   `LoopWatcher` interface (step 04 implements; 01 only defines): `{ id,
   detect(spec), poll(spec, signal): LoopEvent[] }`. Closed unions, no `any`,
   versioned like every contract.
3. **Engine** (`@backend/features/loops/engine.ts`): a PURE reducer
   `(state, event) -> [state, effects[]]` — no timers, no I/O; injectable
   clock. Effects are commands the host executes (`launch-iteration`,
   `run-verify`, `request-review`, `stage-learn`, `notify`, `persist`).
   Transition table matches `LoopState` exactly; illegal transitions throw in
   dev, no-op + log in prod.
4. **Persistence**: specs + run/iteration ledger in the app db (same store as
   Board cards — user content, ADR 0005). Playbook/fix-plan live IN-REPO under
   `.mogging/loops/<slug>/` (step 06); the db never duplicates repo state.
5. **FAKE everything first**: a FAKE trigger (fires on command), FAKE
   iteration executor (deterministic outcomes from a fixture script), FAKE
   verify (exit-code fixtures). The engine must complete a full green run and
   a red→retry→paused-failing run purely on fakes.
6. **LOOPS smoke** (`MOGGING_LOOPS`, env-gated, wired into qa-smokes.sh):
   drives the reducer through: green run end-to-end; budget exhaustion →
   `paused-budget`; three identical red verdicts → `paused-failing`; kill from
   every state → `killed`; asserts a spec without budgets is REFUSED at save.
   Verdict via `out/loops-result.json`.

## Files
- `docs/adr/0009-loops-deterministic-harness.md` · `src/contracts/loops/` ·
  `src/backend/features/loops/` (engine, fakes, store) ·
  `src/main/loops-smoke.ts` · `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- LOOPS gate green in the sweep; sweep count grows by one everywhere the books
  mention it.
- The reducer is 100% synchronous and fixture-tested; every `LoopState` is
  reachable and every reachable state is drawn in the transition table in the
  ADR.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean (engine is
  backend-only; UI sees contracts + IPC exclusively).
- Full local sweep including the new gate.

## Guardrails
- Zero network, zero vendor CLIs, zero real timers in the smoke.
- No new daemon wire surface (protocol stays v3).
- Budgets live in the CONTRACT (non-optional fields), not in validation
  prose — an unbudgeted spec cannot typecheck.
