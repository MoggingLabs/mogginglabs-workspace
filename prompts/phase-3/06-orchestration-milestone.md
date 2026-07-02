# 06 — Orchestration milestone: the end-to-end loop, asserted

**Prereq:** `01`–`05` green. **Shared context:** `prompts/phase-3/README.md` +
`docs/05-perf-budget.md` + `src/main/milestone-smoke.ts` (the Phase-2 pattern to mirror).

## Goal
Prove the Phase-3 promise as ONE asserted flow — *"a board card becomes an isolated
agent, the agent asks for you, you review the diff, you merge — and nothing freezes"* —
and freeze the regression gate for everything this phase added.

## Steps
1. **Smoke** (`MOGGING_ORCHESTRATION`, mirroring the milestone smoke's two-phase style):
   - **Phase A — the loop.** Isolated boot + temp repo → dev-handle a board card →
     start-on-card (shell provider — deterministic; agents' TUIs are covered by the
     template smoke) with worktree isolation → assert: worktree exists; the task marker
     arrived as the pane's first prompt; scripted `mogging send` writes a file change in
     the worktree; `mogging notify --event needs-input` (inside the pane) → card + rail
     flag attention end-to-end; `review:diff` returns the change (and redacts a planted
     fake secret); `review:merge` lands the branch; the card can move to `done`.
   - **Phase B — perf under orchestration.** With the board OPEN and 8 live panes
     (2 worktree-isolated), run the Phase-2 frame sampler for 3s of ANSI torrent +
     4 workspace switches: assert the SAME budget (worst gap ≤ 150 ms, avg fps ≥ 30,
     heap ≤ 300 MB) — orchestration surfaces must not tax the hot path.
2. **Docs**: `docs/07-orchestration.md` — the loop, the control verbs, the safety model
   (worktree-only writes, review-before-merge, redaction), and the demo script.
   Update `docs/02-mvp-and-roadmap.md` Phase-3 checkboxes.
3. **QA wiring**: add `ORCHESTRATION` to `scripts/qa-smokes.sh`; the full sweep is now
   SMOKE → … → MILESTONE → FLICKER → PANEOPS → CONTROL → CONTROL2 → WORKTREE → REVIEW →
   BOARD → ORCHESTRATION → TEMPLATE A/B. All must pass isolated in one run.
4. **README**: mark the Phase-3 sequence table DONE per step, with the measured numbers
   (mirror how `prompts/phase-2/README.md` records its gates).

## Files
- `src/main/orchestration-smoke.ts` + `src/main/index.ts` · `scripts/qa-smokes.sh`
- `docs/07-orchestration.md` · `docs/02-mvp-and-roadmap.md` · `prompts/phase-3/README.md`

## Definition of Done
- One command (`bash scripts/qa-smokes.sh`) proves the ENTIRE product surface — Phase 0
  through Phase 3 — green on fresh isolated state, including the orchestration loop and
  the unchanged perf budget.
- The demo is scriptable: a README snippet using only `mogging …` + the app reproduces
  the loop on a fresh machine.

## Checks that must be green
- `npm run typecheck` → 0; `npm run build` → ok; boundary greps clean.
- Full sweep green (every `MOGGING_*` gate, isolated); budget numbers recorded.
- No terminal content, task text, paths, or credentials in telemetry/state/notify
  payloads introduced this phase (grep + smoke-asserted redaction).

## Guardrails
- Do NOT relax the Phase-2 budget to pass Phase B — throttle/virtualize the new
  surfaces instead (board renders off the hot path; review is lazy).
- The demo uses the shell provider for determinism; never depend on a vendor CLI's
  output shape in an asserted step (ADR guardrail: OSC over hooks, hooks over parsing).
