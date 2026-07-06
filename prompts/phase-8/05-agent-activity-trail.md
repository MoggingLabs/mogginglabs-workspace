The audit trail with teeth (FINDINGS §4.5 — non-negotiable once agents act
on real sessions): ONE local ledger answering "what did agents do as me,
where, and was it allowed" — reviewable from the UI, retained locally,
never telemetry. 03/04 already emit through the `recordTrail()` stub; this
step gives it a store, a viewer, and a gate.

## Steps
1. **The store** (`@backend/features/integrations/trail.ts`): append-only
   JSONL per workspace under userData (`trail/<workspaceId>.jsonl`),
   ring-capped (2000 entries or 1 MB — oldest-half rewrite on overflow).
   NOT the settings KV: entries are high-churn and user-clearable. Entry =
   01's `TrailEntry` verbatim — `target` is an ORIGIN (web), a pane/card
   ref (mcp), or a webhook LABEL (bridge, 09 — never its URL). Writes are
   queued fire-and-forget; a full disk drops entries + one loud log line,
   never a crash.
2. **Wire the emitters**: `recordTrail()` (03's receipts + 04's
   `agentAct()` instrumentation) lands here — acts, refusals, confirms,
   origin-changes, MCP writes. One emission, two sinks (notify receipt +
   trail); no caller changes shape.
3. **The viewer**: an Activity block in Settings § Integrations (one-home
   rule — 06 builds the section; land on a minimal shell if 06 hasn't run,
   the 7/03 stub pattern with an absorption note) — reverse-chronological,
   filter by workspace/source, outcome badges (ok/refused/confirmed) in
   house tokens, relative times via the ONE formatter. Plus a compact
   "recent acts" strip on the dock possession surface (last 3 for the
   possessing workspace). "Clear this workspace's trail" is a user verb
   with confirm; export = a local JSON save dialog.
4. **Retention honesty**: viewer copy states plainly — kept on this
   machine, capped, cleared by you, never sent anywhere. The FINDINGS
   threat model in user words: "an agent on your live sessions can be
   manipulated into acting as you — this page is how you check what it
   did."
5. **WEBTRAIL smoke** (`MOGGING_WEBTRAIL`, env-gated, in qa-smokes.sh):
   fixture world driving 04's site + scripted MCP frames — (a) granted
   click → `web/ok` entry, ORIGIN as target; (b) ungranted click →
   `web/refused` + reason; (c) MCP `send_to_pane` → `mcp/ok` + pane ref;
   (d) the file contains NO eval body, page text, cookie, or URL beyond
   origins (grep known fixture strings — absence is the assert); (e) ring
   caps (seed 2100 → ≤2000, oldest gone, newest intact); (f) entries
   survive restart; (g) clear-workspace empties exactly that file; (h) the
   viewer renders the entries (DOM asserts). Verdict
   `out/webtrail-result.json`.

## Files
- `src/backend/features/integrations/trail.ts` · main wiring ·
  `src/ui/features/settings/` (Activity block) · dock strip ·
  `src/contracts/ipc` · `src/main/webtrail-smoke.ts` · qa-smokes.sh gate
  row · gallery (both themes)

## Definition of Done
- Dev-verified (books): after a real agent-web session on a granted
  origin, the viewer answers what happened — verbs, origins, outcomes,
  times — zero content leakage in the raw file (inspected).
- Every 03 receipt and 04 act/refusal/confirm/origin-change lands exactly
  one entry; no emitter bypasses the store.
- WEBTRAIL gate green; sweep count bumped in the books.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; MILESTONE + PERCEPTION re-run (renderer touched).

## Guardrails
- REFS, structurally: origins, pane/card refs, labels — the entry type has
  no field a content string could hide in; the smoke greps the raw file.
- LOCAL forever: no IPC exposes the trail beyond the viewer's read; no
  telemetry event carries an entry — a count is the ceiling (ADR 0005).
- Evidence, not enforcement: gating stays in `agentAct()` and server
  dispatch — a trail write failure never blocks an action.
- Off the perception hot path: queue + idle flush; PERCEPTION proves it.
