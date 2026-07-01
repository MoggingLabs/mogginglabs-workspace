# 05 — Perf budget + the 16-agent milestone

**Prereq:** `01`-`04` green. **Shared context:** `README.md` + `docs/03-research-synthesis` §8
(perf at high pane counts is the #1 risk — BridgeSpace's exact failure mode).

## Goal
Prove the Phase-2 milestone: **"16 agents, see who needs you at a glance, nothing freezes."**
A hard perf budget + a repeatable demo/smoke: 16 panes with agents, attention indicators live,
UI responsive.

## Steps
1. **Perf budget** — define + assert: 16 panes toward a 60fps target, capped RAM, main thread
   never blocked > a set threshold. WebGL per pane within the browser context limit; DOM-renderer
   fallback + background-pane throttling beyond it (extend the Phase-1/04 layout perf notes).
2. **Attention at scale** — with 16 agents flipping busy/attention, tab rings + dock badge (01),
   command blocks (02), and per-pane git (03) all update without jank; the "who needs me" scan is
   instant.
3. **Milestone smoke** — env-gated: spawn 16 panes, drive OSC/`mogging notify` to flip several to
   attention, assert tab rings update and no main-thread stall / dropped frames over a window.
4. **Document** the budget + measured results (a perf note in `docs/`); a regression fails the gate.

## Files
- `src/main/**` (the milestone smoke), `src/ui/**` (throttling/virtualization for background
  panes), a perf note under `docs/`.

## Definition of Done
- 16 panes with agents run; attention indicators are correct; the UI stays responsive (budget met).
- The milestone smoke passes and is repeatable.
- No regression to the Phase-0/1 smokes.

## Checks that must be green
- Milestone smoke (16 panes) green; the perf budget is asserted, not just eyeballed.
- `npm run typecheck` -> 0; `npm run build` -> ok; all prior smokes still green.

## Guardrails
- Perf is the make-or-break (ADR 0001 de-risks divergence, not raw perf). If the budget can't be
  met, throttle/virtualize before adding features. Never freeze the main thread.
