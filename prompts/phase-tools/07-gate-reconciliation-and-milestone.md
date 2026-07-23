# 07 — Gate reconciliation, CC-first polish, docs, and the composed milestone

Read README + the survey first. Final step: prove the whole, and prove nothing was
weakened along the way.

## Goal
Audit every existing gate this phase touched, finish the tool-first sweep across
straggler surfaces, rewrite docs/14 around the new model, and land one composed gate
that walks the entire promise end-to-end.

## Deliverables
1. **The gate audit** (the step's core — regressions die here). For EVERY existing
   gate that touches this surface — CONNPURE, CONNLIVE, SETINTEG, MCPCAT, AUTHRUNNER,
   integux, MUTATIONRACE, SECRETFORMS, USAGESET's integrations edges, the wording
   gates — produce a table in REPORT.md: what the gate proved BEFORE the phase, what
   it proves NOW, and for each assertion that moved: the new selector/contract that
   carries the SAME guarantee, or an explicit line justifying retirement. Any gate
   whose assertions shrank without justification is a step failure. Then stash-probe
   discipline: full sweep at the pre-phase baseline commit and at HEAD on the same
   box — zero unexplained deltas.
2. **Straggler sweep.** Grep every surface still enumerating CLIs or speaking
   plumbing: wizard Agent-tools step, guided flow, palette verbs, empty states,
   toasts, Library captions, onboarding. Each adopts the ADR 0020 naming table or is
   explicitly TOOLWORDS-allowlisted with a one-line reason (fine-print custody lines
   are the intended survivors).
3. **Coming-soon honesty.** Greyed Codex/Gemini rows carry ONE consistent caption;
   an installed-but-coming-soon CLI must not look broken (agents.detected shim in
   smokes).
4. **docs/14-integrations.md rewrite**: the tool is the unit; connect methods in
   outcome words; identity (probed / noted / fallback + precedence); status
   freshness (three triggers, one table); the reconciler ("Fix is always your
   click"); the catalog as the contribution path (a provider = a data PR with
   provenance); custody unchanged + the local-only differentiator (ADR
   0014/0002/0020). Route A/B survives only in the architecture appendix. The
   in-app privacy block re-worded — `check-credential-wording.mjs` keeps passing.
5. **Gate-count prose** re-mechanized (`check-gate-count.mjs`) for the phase's six
   new gates (CATSCHEMA, TOOLCRED, TOOLPULSE, TOOLWHO, TOOLCARDS, TOOLFIX — plus
   TOOLSMILESTONE = seven); update every counted file the script names.
6. **REPORT.md** for the pack: per step — what landed, gate + bite proofs, deviations
   from the prompt with reasons, and the step-1 gate-audit table.

## Gate — TOOLSMILESTONE (composed)
One env-gated smoke walking the WHOLE promise on the fixture AS, in order: fresh
profile → Integrations shows tools only (assert the TOOLWORDS banned list against
live DOM textContent, not just source) → connect the GitHub fixture via "Sign in
with your browser" → card flips Connected with verified-ago tag → identity email
lands (`accountSource` asserted) → user adds an account note on an identity-less
tool → scope it into a workspace from the detail → launch a pane there →
pre-launch verify stamps fresh within budget, pane env carries the tool →
hand-break the fixture → attention raises app-wide within one accelerated beat →
Fix repairs a drifted Claude Code config (diff preview shown, backup created) →
disconnect deletes the credential; the card returns to Not connected with the note
surviving. Every arrow is an assert. Bracket red/green.

## Guardrails
- Full sweep vs baseline BEFORE and AFTER; zero new reds (stash-probe suspects;
  quiet box for perf; MILESTONE/PERCEPTION unchanged — heartbeat is post-paint
  async, prove it). npm static battery sequential (NPMCONFIG lesson).

## Done when
TOOLSMILESTONE green; the gate-audit table complete with zero unexplained
shrinkage; sweep green vs baseline; docs/14 + REPORT.md landed.
