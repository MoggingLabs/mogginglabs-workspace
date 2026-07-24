# 03 — The OpenAPI curator: specs in, DRAFTS out, humans decide

Read the pack README + the survey first. Builds on steps 01–02.

## Goal
Make authoring `restTools` cheap without inheriting the generators' blindness: a
CURATOR script that reads an OpenAPI document and emits DRAFT catalog blocks — 
capped, typed, provenance-stamped — that a human trims, rewords, and dev-verifies
before anything ships. The spec is input; the catalog stays the truth.

## Deliverables
1. **`scripts/curate-rest-tools.mjs`** (node, zero deps beyond the repo's):
   `node scripts/curate-rest-tools.mjs <spec-path-or-url> --service <id> [--pick op1,op2…]`
   - Parses OpenAPI 3.x (JSON or YAML via the repo's existing yaml dep if present;
     else JSON only — do not add a dependency for step one);
   - WITHOUT `--pick`: lists candidate operations (method, path, operationId,
     summary, params count, read/write guess from the HTTP verb) ranked
     read-first — a MENU, not output;
   - WITH `--pick`: emits the draft `restTools` JSON block to stdout — names
     snake_cased from operationId (flagged `TODO-reword` so the agent-UX naming
     pass is never skipped), descriptions from summary (same flag), typed params
     mapped (path/query/body, required honored), `readOnly` from the verb,
     per-tool `source` = the spec's own URL + the op's path pointer, and the
     step-01 CAP enforced at emit (refuse >12 with the Speakeasy sentence: fewer,
     better-worded tools beat coverage);
   - NEVER writes into `catalog/` itself — stdout only; the human pastes, rewords,
     and CATSCHEMA/RESTSCHEMA judge the result.
2. **The curation checklist**, appended to ADR 0021: reword every name/description
   for an agent choosing among tools; drop anything an agent should not do
   unattended; verify each tool live with a real key before stamping
   `verifiedAt`; a `TODO-reword` marker anywhere in the catalog is a RESTSCHEMA
   failure (add the rule + selftest mutation — drafts cannot ship).
3. **Fixture spec** under `tests/fixtures/` (a small 20-op OpenAPI doc with reads,
   writes, path/query/body params, and one absurdly-parameterized op) for the gate.

## Gate — RESTIMPORT (static, `run_static`)
Drives the curator against the fixture spec: (a) menu mode lists all 20 ops
read-first; (b) picking 4 emits a block that PASSES RESTSCHEMA except for the
deliberate `TODO-reword` markers (asserted present — the human pass is forced);
(c) picking 13 refuses on the cap; (d) the emitted `source` pointers name the
fixture spec + op; (e) a write op emits `readOnly:false`. Selftest-style
mutation-red ×2: break the cap refusal ((c) must red); break the TODO-reword
stamping ((b)'s marker assert must red).

## Guardrails
- The curator runs OFFLINE against a file; `--url` fetch is a convenience that
  must never run inside any gate (fixture-file only in the sweep).
- No runtime code path may import the curator (grep-proven; it is tooling).

## Done when
RESTIMPORT green ×2 mutation-reds; RESTSCHEMA's new TODO rule biting; sweep green
vs baseline.
