The bytes are defended; the DECISION is not. Every cap — `maxPanes`
(`controller.ts:1195`), `maxSwarmRoles` (`:449`), `maxRemotes`
(`profiles-hosts.ts:434`) — is COMPUTED IN THE RENDERER by
`entitlements-store.ts:47`, which ships as plain JS (bytecode covers the
main process only — `check-bytecode.mjs:29`) and **fails OPEN to
Infinity**, so deleting a row grants unlimited. Asar integrity stops byte
edits on Win/macOS but is inert on Linux and rests on the operator's
deferred signature (14b). A protected byte is not a protected decision:
move the decision behind the wall.

## Steps
1. **Inventory the gate points** (`INVENTORY.md` rows): every call to
   `entitlementLimit`/`allows` and every place a plan name is compared, one
   row each with `file:line` + what it withholds. If a surface gates on
   plan and is not a row here, it is unaudited. Include the wizard/painter
   caps (`wizard/index.ts`, `grid-painter.ts`) which read capacity today.
2. **Invert the seam — main DECIDES, renderer RENDERS.** Add a decision
   verb to the entitlements IPC contract: the renderer asks "may I add a
   pane / claim a role / save a remote?" and receives allow/refuse plus the
   honest sentence to show. It never computes a cap. The claims snapshot
   stays, but is demoted to **display only** ("Your plan: 4 panes") — never
   an input to a branch that grants.
3. **Enforcement fails CLOSED.** `contracts/entitlements/index.ts:60`
   deliberately fails open so a missing row never breaks a feature — keep
   that for DISPLAY, but the main-side decision reads a CLOSED table of
   enforced names: an enforced name with no row REFUSES, and an unknown
   name is not enforceable at all. Deleting a row must never widen a cap.
4. **PLAINGATE static gate** (`scripts/check-plain-enforcement.mjs`,
   qa-smokes row): parses the BUILT `out/renderer` and fails if any
   enforcement survives in plain text — a numeric cap literal, a
   `limits[...]` read feeding a branch that grants, or a plan-name
   comparison deciding capability. Display reads are allowlisted by name.
   Bite-prove it: reintroduce one renderer-side cap → red. Verdict
   `out/plainenforce-result.json`.
5. **Re-measure**: the decision now costs an IPC round trip on pane-add and
   role-claim. Prove it is off the hot path (never per-frame, never
   per-keystroke) and that MILESTONE + PERCEPTION are unmoved; if a verb
   lands in a loop, batch it rather than widening a budget.

## Files
- `src/contracts/ipc/entitlements.ipc.ts` (decision verb) · `src/main/
  entitlements.ts` (the closed table + decisions) · `src/ui/core/
  entitlements/entitlements-store.ts` (demoted to display) · the gate-point
  callers · `scripts/check-plain-enforcement.mjs` · `scripts/qa-smokes.sh`
  · `docs/23-threat-model.md` · `CHECKLIST.md` (mark 14a)

## Definition of Done
- No renderer file decides capability: every gate point calls main and
  renders the answer; PLAINGATE green + bite-proven.
- An enforced name with no row REFUSES (fail-closed proven by a unit);
  display still fails open and no feature breaks over a missing row.
- Patching the renderer bundle no longer widens a cap — proven by editing
  the built bundle in a gate fixture and seeing the cap hold.
- MILESTONE + PERCEPTION unmoved; the decision verb is provably not
  per-frame.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; PLAINGATE; ACCOUNT +
  the entitlement/device gates; PRODMILESTONE; both budgets.

## Guardrails
- This is FRICTION, not a wall (ADR 0016 §5) — main-process bytecode
  raises the cost from "edit a line" to "reverse V8 bytecode". Say that;
  never call it protection.
- The renderer stays honest: a refusal shows a real sentence naming the
  plan and the cap, never a silent no-op.
- No token, JWT, or private value crosses IPC — the decision verb answers
  allow/refuse plus copy, nothing more.
