# 02 — The credential core: normalize, refresh, prove-before-save

Read README + the survey first. Foundation layer two: every credential behavior the
survey proved out, in main, catalog-driven. No UI moves.

## Goal
One canonical credential shape, one normalization seam, Nango-grade refresh discipline,
and Activepieces-grade prove-before-save — replacing today's scattered token handling
in `src/main/connections.ts` / `connect-orchestrator.ts` / `grant-store.ts`.

## Deliverables
1. **Canonical credential** (contracts): `{accessToken, expiresAt?, refreshToken?,
   refreshTokenExpiresAt?, scopes[], tokenType, obtainedAt, method}` — stored as
   keychain ciphertext exactly as today (ADR 0014 custody untouched; no IPC channel
   ever carries it — the 8/08 discipline).
2. **Normalization at exchange** (mcp-s-oauth's lesson, MIT — its mappings may be
   consulted verbatim): ONE function turns any raw token response into the canonical
   shape at the moment of exchange/refresh — `expires_in`→`expiresAt` immediately,
   GitHub's `refresh_token_expires_in` handled, form-vs-JSON responses, quirks read
   from the catalog method (`tokenExpirationBuffer` etc.). No downstream code ever
   reads a raw response field.
3. **Refresh discipline** (Nango's refresh.ts behaviors, re-implemented):
   - per-connection **in-process lock** so concurrent demand (proxy call + heartbeat +
     manual Check) never double-refreshes — the OAuth 2.1 rotation race ADR 0014 §
     refresh predicted;
   - **freshness margin**: refresh when `expiresAt - margin` passes, not on expiry;
   - **failure cooldown**: a provider that refused refresh isn't re-hammered for N
     minutes; the connection shows `expired` per existing rules;
   - **re-check after lock**: the winner refreshes, the waiter re-reads and finds
     fresh credentials — assert this exact sequence in the gate;
   - non-rotating providers (Metorial's lesson): a refresh response without a new
     refresh_token KEEPS the old one.
4. **Prove-before-save** (Activepieces): every method declares its validator — for
   `apiKey` methods the catalog `verification` probe; for OAuth the landed grant IS
   the proof (CONNPURE law — do not add a probe to the connect critical path). submitKey
   already proves; this step routes it through the catalog probe instead of hardcoded
   per-service logic, keeping submitWithRetain retain/scrub behavior byte-identical.
5. **Catalog-driven proxy retries**: the bridge proxy reads the service's `retry`
   metadata (rate-limit headers, retryable codes) instead of blind retries.
6. `connect-orchestrator.ts` consumes catalog `methods[]` for endpoints/scopes/quirks —
   deleting the per-service special cases that duplicate what the catalog now states.

## Gate — TOOLCRED
Env-gated smoke on the fixture AS (SMOKE_ENV registered): (a) exchange against a
fixture returning GitHub-shaped quirks (`refresh_token_expires_in`, form-encoded) —
canonical shape asserted, no raw field leaks past the seam; (b) two concurrent
refresh demands → exactly ONE token request at the fixture (call-count asserted),
waiter gets the winner's credentials; (c) freshness margin honored (clock knob);
(d) refresh refusal → cooldown suppresses the next attempt (fixture call-count),
state `expired`; (e) non-rotating refresh keeps the old refresh token; (f) a bad
API key is REFUSED by the catalog probe before anything saves, field retained
(SECRETFORMS behavior re-asserted). Mutation-red ×2: break the lock (b must go red);
break normalization (a must go red).

## Guardrails
- CONNPURE + CONNLIVE must stay green UNCHANGED — this step must not alter the
  landed-grant state machine, only what happens around it.
- Existing grant-store data migrates forward (a v-next record read shim); no user
  reconnects because we refactored.

## Done when
TOOLCRED green with both mutation-reds; sweep green vs baseline; connect/disconnect
behavior byte-identical from the user's seat.
