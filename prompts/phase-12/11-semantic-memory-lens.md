The cipher/ByteRover shape, organ one: SEMANTIC memory recall — fuzzy
retrieval over the `.memory/` graph. Clean-room, shape only
(Elastic-2.0 = ⛔ code; the asciinema format-only precedent). The core
law bends, honestly: ADR 0018 gains the LENS LAW.

## Steps
1. **ADR 0018 revision A — the lens law**: a probabilistic answer
   may exist only when (a) the workspace opted in; (b) the provider
   + key are the USER'S OWN (ADR 0002's spirit: we never proxy,
   never meter, take no cut); (c) every hit is labeled
   `probabilistic: true` with provider+model; (d) no deterministic
   path gates on it — exact search, backlinks, suggestions, and the
   offline core are byte-identical with the lens off. Record the
   cipher lineage + the license stance (shape taken, code refused).
2. **The provider seam** (`brain/embed.ts`, main-side):
   `embed(texts[]) -> vectors` behind ONE adapter:
   OpenAI-compatible HTTP (covers OpenAI/Azure/Ollama/LM Studio —
   local endpoints welcome, so even the lens can be offline).
   Endpoint + model are per-workspace settings; the key rides the
   phase-7 vault pointer grammar (ADR 0007a: ciphertext at rest,
   NEVER in a config file). Consent `brain.semanticMemory`, default
   OFF, house consent card + single-fire failure toast. A FAKE
   deterministic embedder (seeded hash → vector) ships for smokes.
3. **The vector index** (brain db `memory_vectors(slug, contentHash,
   model, dim, vec BLOB)`): embed on 04's memory drain, consent ON
   only; content-hash keyed — an unchanged memory NEVER re-embeds
   (counted); model change invalidates rows honestly; caps on dims +
   rows. Cosine similarity is house code, in-process over the db —
   NO external vector store, no new service, no new dep.
4. **The tool**: `search_memories` gains `mode: 'exact'|'semantic'|
   'hybrid'` (default `exact` — 09's behavior byte-identical).
   Semantic/hybrid hits carry `{ probabilistic: true, provider,
   model, score }`; hybrid = fixed-weight FTS+cosine blend, full
   breakdown returned — auditable even when fuzzy. Consent OFF →
   semantic modes refuse `consent`; exact always answers offline.
   Query embeds happen per call, capped.
5. **BRAINSEM smoke** (`MOGGING_BRAINSEM`, dispatch branch,
   qa-smokes.sh row; FAKE embedder, zero network): (a) consent OFF:
   semantic refuses typed, exact unchanged; (b) consent ON: a
   fixture pair with disjoint vocabulary but FAKE-similar vectors
   found by semantic, missed by exact — the value, proven;
   (c) every semantic hit labeled; hybrid breakdown weights sum;
   (d) re-drain an unchanged memory → 0 re-embeds; edit → exactly
   1; (e) model swap invalidates, re-embeds on next drain; (f) the
   key: vault pointer resolves, plaintext greps to ZERO files after
   the run; (g) lens OFF: 09's MEMGRAPH assertions still pass
   byte-identical. Verdict `out/brainsem-result.json`.

## Files
- ADR 0018 (revision A) · `brain/embed.ts` + `memory_vectors`
  migration · `serve.ts` + `bin/mogging-mcp.mjs` (mode arg) ·
  consent + endpoint/model settings card · vault pointer wiring ·
  `smokes/brainsem-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINSEM green; the sweep count grows by one.
- With a real local endpoint (Ollama), a vague query finds the
  right memory — verified once by hand.
- MEMGRAPH + BRAINDOCS green unmodified; wording gate green on the
  new consent copy.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (incl.
  check-credential-wording); the pack's gates green in isolation.

## Guardrails
- BYO only: no bundled model, no default endpoint, no app-side
  proxy — requests leave ONLY for the user's configured endpoint.
- Labels are load-bearing: an unlabeled probabilistic hit is a
  review rejection.
- The deterministic path may not change by one byte when the lens
  toggles.
- Smokes never touch the real net; FAKE embedder always.
