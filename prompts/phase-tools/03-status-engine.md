# 03 — The status engine: heartbeat, page entry, pre-launch

Read README + the survey first. Builds on step 02's credential core.

## Goal
"✓ Connected · verified Xm ago" becomes TRUE by construction: one verification engine,
three triggers, catalog-driven probes, app-wide attention on failure. This continuous
re-verify is OUR differentiator — no surveyed project has it (Activepieces validates
once and trusts forever; the survey names this weakness). Backend + wiring only; the
card that renders it arrives in step 05.

## Deliverables
1. **One verify path.** `verifyConnection(serviceId, cause)` in main funnels EVERY
   verification — manual Check, heartbeat, page entry, pre-launch — and stamps
   `verifiedAt` + `verifyCause`. Probe selection is catalog-driven (step 01):
   MCP services → `initialize` + `tools/list` over the app-held grant (today's probe);
   key-auth services → the catalog `verification` block (method/endpoint/headers) —
   the probe API-key connections never had. CONNPURE laws hold for every cause: a
   failed probe NEVER un-connects a valid grant; only the unauthorized-resource
   downgrade means `expired`; enrichment merges via `connectionEnrichmentPatch`;
   `enrichmentTargetsSameGrant` guards every stale write.
2. **Trigger 1 — heartbeat** (~15 min): re-verifies every `connected` connection,
   **staggered with jitter** (never one stampeding tick), with a Nango-style **budgeted
   sweep**: hard wall-clock budget per beat, cursor resumes next beat — 40 connections
   must not own the event loop. Starts AFTER first paint, async (invariant I7). Uses
   step 02's refresh discipline: a due refresh inside a beat rides the same lock +
   margin + cooldown. Skips while offline — a probe failure classified network-down
   (the updater's reachability heuristics) says nothing and flips nothing.
3. **Trigger 2 — page entry**: entering Integrations requests exactly one sweep (the
   existing request→push→repaint contract; the pollRequests/pushPaints counters keep
   counting causes).
4. **Trigger 3 — pre-launch**: a pane launching with a plan that carries connected
   tools verifies them first — parallel, hard ~2s budget, launch NEVER waits past it;
   late results land as status afterward. Wire at the seam where the plan
   materializes into launch env.
5. **Attention**: a real verification failure raises the attention port (ALERTAGREE) —
   rail badge + dot — and a later success clears it. Edges only, no toast spam.
   Network-down never raises.
6. Contract: `verifiedAt`/`verifyCause` on the `Connection` shape (secret-free,
   additive).

## Gate — TOOLPULSE
Env-gated smoke on the fixture AS: (a) heartbeat re-stamps `verifiedAt` on an
accelerated interval knob, and with N fixture connections the beat respects its
budget (fixture asserts staggering — max concurrent probes bounded); (b) a key-auth
fixture service is verified via its catalog `verification` endpoint (fixture asserts
the exact path was hit); (c) page entry = one poll exactly; (d) pre-launch verify
runs before env materialization and a fixture-delayed probe does NOT delay the pane
past budget (launch timestamp asserted); (e) fixture killed → attention raised while
Settings is NOT active; fixture network-blackholed → NOT raised; recovery clears.
Mutation-red ×2: break the network-down classifier ((e) must red); break the budget
((d) must red).

## Guardrails
- Perf gates on a QUIET box; stash-probe before blaming the diff (the MILESTONE
  lesson). MILESTONE/PERCEPTION numbers unchanged.
- No verify on the connect critical path (landed-grant law).

## Done when
TOOLPULSE green with both mutation-reds; CONNPURE/CONNLIVE/TOOLCRED green; sweep
green vs baseline.
