The second and third mechanism classes: `api-key` (paste once, OS-keychain
encrypted, WRITE-ONLY forever after) and `cloud-cli` (ambient cloud
credentials via the vendor CLI). Together ~25 of CodexBar's providers —
easier than CodexBar for normal users, stricter at rest. Research:
`docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **ADR 0007.a — keys at rest** (`docs/adr/0007a-usage-keys-at-rest.md`):
   the HEADLINE path is paste-once → Electron `safeStorage` (OS-keychain-
   backed: DPAPI / macOS Keychain / libsecret) → only CIPHERTEXT persists,
   in the settings KV. Binding semantics: **write-only** — a saved key can
   be REPLACED or DELETED but never viewed again; no IPC channel that
   returns plaintext to any renderer EXISTS (absence of the channel is the
   guarantee, not discipline). Decrypt happens backend-side, in memory, for
   the one usage request, dropped after. If `safeStorage.
   isEncryptionAvailable()` is false (Linux without a keyring), REFUSE to
   store and offer the env-ref path — never plaintext at rest. The env-ref
   pointer (`${OPENROUTER_KEY}`, resolved at request time) remains the
   power alternative. Divergence from CodexBar stated: they write keys to a
   config file; we hold ciphertext the OS vault controls, and never show it
   back.
2. **Key slots** (`@contracts/usage`): `KeySlot = { kind: 'keychain' } |
   { kind: 'env-ref', envRef } | { kind: 'none' }` — the IPC surface is
   `set` (plaintext in, encrypted immediately, never echoed), `clear`, and
   a PRESENCE boolean; no getter. A secret-shaped literal in an env-ref
   slot is refused (the profile deny-list heuristic).
3. **The `api-key` class adapter**: one bounded usage/balance endpoint per
   refresh, key resolved per the slot (decrypt or env) in memory. Rows:
   OpenRouter, DeepSeek, Moonshot, MiniMax, z.ai, Venice, Poe, Chutes,
   Deepgram, ElevenLabs, GroqCloud, LiteLLM (+proxy URL), LLM-Proxy
   (+base URL), ClawRouter, Crof, Doubao, Warp, Alibaba (key mode),
   OpenAI Admin + Claude Admin (spend). 401/403 → `error` "key rejected —
   replace it in Settings"; missing → `unconfigured` naming the fix.
4. **The `cloud-cli` class adapter**: Vertex AI (`gcloud auth
   print-access-token`), AWS Bedrock (profile/SSO → Cost Explorer) —
   execFile with timeout, token in memory once, never stored. No CLI /
   logged-out → labeled states.
5. **Fixture + smoke growth** (USAGE grows): credit/spend/metric shapes
   normalize; `set` stores ONLY ciphertext (the pasted plaintext is absent
   from the settings DB bytes — asserted); no IPC channel returns it (the
   channel allowlist is grepped); presence flips the UI state; `clear`
   removes; replace overwrites; encryption-unavailable → store refused with
   the env-ref hint; env-ref literal refused.

## Files
- `docs/adr/0007a-usage-keys-at-rest.md` · `src/contracts/usage/` (KeySlot)
  · `src/backend/features/usage/classes/api-key.ts`, `cloud-cli.ts`, key
  store · `src/main/usage.ts` (set/clear IPC) · `src/main/usage-smoke.ts` ·
  books (verified shapes + dates)

## Definition of Done
- Paste a real OpenRouter key in dev: usage loads; the key is never visible
  anywhere again — only "saved · Replace · Delete"; delete kills the fetch
  path; replace works (books).
- One cloud-cli provider (Vertex or Bedrock) returns usage from the user's
  own CLI session.
- Plaintext-at-rest assert green; no-getter grep green; USAGE gate green.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep including the grown USAGE gate.

## Guardrails
- WRITE-ONLY is structural: no plaintext read-back channel exists, period —
  not settings-export, not debug, not the smoke result JSON.
- Never plaintext at rest: encryption unavailable = storage refused (env-ref
  offered), not a silent downgrade.
- One request per provider per refresh; 429 dims to stale, never a storm.
- Key values and provider balances never enter telemetry (ADR 0005); no new
  daemon wire surface (protocol stays v3).
