The second and third mechanism classes: `api-key` (the user's own key as an
ENV-REF pointer — we never store it, unlike CodexBar which writes keys to
its config) and `cloud-cli` (ambient cloud credentials via the vendor CLI).
Together these are ~25 of CodexBar's providers. Research:
`docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **The `api-key` class adapter**: reads ONE bounded usage/balance endpoint
   with the user's key, supplied as an ENV-REF pointer (`${OPENROUTER_KEY}`)
   resolved at request time — the SAME pointer philosophy as profiles /
   ADR 0008.d. We never persist, echo, or store the key; a secret-shaped
   LITERAL in a provider config is refused (the profile deny-list heuristic).
   Ships these rows (credit/balance/spend normalize to a `credits` block or a
   rolling window): OpenRouter, DeepSeek, Moonshot/Kimi-API, MiniMax, z.ai,
   Venice, Poe, Chutes, Deepgram, ElevenLabs (character credits), GroqCloud
   (Prometheus metrics), LiteLLM (virtual key + proxy URL), LLM-Proxy
   (key + base URL), ClawRouter, Crof, Doubao, Warp (GraphQL token),
   Alibaba (key mode), OpenAI Admin + Claude Admin (spend graphs).
2. **The `cloud-cli` class adapter**: ambient credentials via the vendor's
   own CLI, read at request time — Vertex AI (`gcloud auth print-access-
   token`), AWS Bedrock (`aws` profile / SSO / assume-role → Cost Explorer).
   ExecFile the CLI with a timeout, token to memory for the one call, never
   stored. No CLI / logged-out → `unconfigured`/`error` with the human fix.
3. **Config shape for keys** (`@contracts/usage`): a provider's key slot is
   `{ envRef: string }` on the provider's settings, validated like a profile
   env value (name shape `^[A-Z][A-Z0-9_]{2,40}$`, value refused if
   secret-shaped). Base-URL/proxy-URL/profile-name are plain config fields.
4. **Degradation + politeness**: every adapter one bounded request per
   refresh; 401/403 → `error` "key rejected — check {envRef}"; 429 → `stale`
   + long backoff (the seam already does this); missing key → `unconfigured`
   "set {envRef} to your … key". Never a throw into the UI.
5. **Fixture + smoke growth**: FAKE fixtures for credit-balance, spend-graph,
   Prometheus-metric, and dollar-balance shapes; the USAGE gate asserts each
   normalizes and that a secret-shaped key literal is refused at config save.

## Files
- `src/backend/features/usage/classes/api-key.ts`, `cloud-cli.ts` +
  per-provider config · `src/contracts/usage/` (key-slot shape) ·
  `src/backend/features/usage/fake-adapter.ts` · `src/main/usage-smoke.ts` ·
  books (verified shapes + dates)

## Definition of Done
- At least one api-key provider (OpenRouter) and one cloud-cli provider
  (Vertex or Bedrock) return normalized usage in dev from the user's own
  key/CLI; both degrade to labeled states.
- A secret-shaped literal in a provider key slot is refused at save
  (smoke-asserted); env-ref pointers resolve at request time and never
  land in any snapshot, log, or telemetry payload.
- USAGE gate green; sweep count unchanged.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the grown USAGE gate.

## Guardrails
- ADR 0008.d: keys are POINTERS. The app stores no secret literal, ever —
  the deliberate divergence from CodexBar (which stores keys in its config).
- One request per provider per refresh; ETag/If-None-Match where the API
  supports it; a 429 dims to stale, never a retry storm.
- Provider names, balances, and endpoints never enter telemetry (ADR 0005).
- No new daemon wire surface (protocol stays v3).
