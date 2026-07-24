# 02 — The bridge executor: catalog tools over vault-held keys

Read the pack README + the survey first. Builds on step 01's schema.

## Goal
The house bridge serves a service's `restTools` as real MCP tools: `tools/list`
from the catalog, `tools/call` = ONE pinned REST request with the vault-held
credential injected server-side. Custody unchanged; agents get capabilities,
never keys, never URLs of their choosing.

## Deliverables
1. **The executor** (pure core in `backend/features/integrations/rest-bridge.ts`,
   wired where the connection shim already serves MCP): given a service id whose
   catalog row declares `restTools` and whose credential rests in the vault
   (`accessTokenFor` — the ONE decryption point, unchanged):
   - `tools/list` → the curated tools, names/descriptions verbatim from the
     catalog (this IS the anti-explosion surface: ≤12, agent-worded);
   - `tools/call` → validate args against the typed params (unknown/missing →
     typed refusal, never a guessy request), interpolate PATH/QUERY/BODY params
     into the PINNED endpoint (encodeURIComponent per segment; `${connectionConfig}`
     placeholders resolved from the stored connection — never from args), inject
     auth per `restAuth`, execute with the catalog `retry` grammar
     (retryableStatus/retryDelayMs — already built, phase-tools/02);
   - responses: `responsePath` shaping, `pagination` (follow ≤3 pages, merge item
     arrays), then a HARD response cap (~50KB text) with an honest truncation
     sentence — an agent context is not a firehose;
   - failures: provider status + a short body excerpt, never headers, never the key.
2. **The write gate.** `readOnly:false` tools are listed but REFUSE execution
   unless the calling workspace's grant says `writeTools:'all'` — the SAME grant,
   read at the same seam MCP write tools read it. The refusal names the switch.
3. **Pinning, proven**: no code path builds a URL from agent-supplied strings
   except through declared params; a param value containing `://` or `..` into a
   PATH slot is refused (typed refusal).
4. **Status/identity ride free**: a restTools service verifies via its catalog
   `verification` block (the engine already prefers it for key-auth) and names its
   account via `profile` — assert both engines need ZERO changes.
5. Telemetry stays counts/booleans (ADR 0005): bridge calls counted, never named.

## Gate — RESTEXEC
Env-gated smoke on a fixture REST API: (a) tools/list = exactly the catalog set,
verbatim; (b) a read call lands with the key injected per `restAuth` (fixture
asserts header), args typed-validated (a bad arg → typed refusal, zero fixture
hits); (c) pagination merges pages and STOPS at the cap; the response cap
truncates honestly; (d) 429 with the provider's reset header retries per the
catalog grammar (fixture asserts spacing); (e) a write tool refuses without the
grant, executes with it (fixture asserts exactly one hit each way); (f) a
path-traversal/absolute-URL arg is refused with zero fixture hits. Mutation-red
×2: break the write gate ((e) must red); break the pinning ((f) must red).

## Guardrails
- Zero new custody: no new decryption point, no new vault key shape.
- The MCP route is untouched: a service with BOTH mcp.url and restTools serves
  the provider's MCP when connected that way — the bridge is the KEY route.

## Done when
RESTEXEC green ×2 mutation-reds; TOOLCRED/CONNPURE/TOOLPULSE green; sweep green.
