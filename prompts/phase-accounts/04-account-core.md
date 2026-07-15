The account starts at the TOKEN HOLDER, not the Settings screen. Build the
one module that logs in and holds credentials — PKCE in the system browser,
DPoP-bound tokens, vault custody — reusing the OAuth machinery Connections
already proved. Claims cross IPC; tokens never do. FAKE IdP only.

## Steps
1. **`src/main/account.ts`** — the SOLE token holder. Login runs OAuth 2.1
   Authorization Code + PKCE(S256) in the user's own browser via
   `shell.openExternal` + an ephemeral `127.0.0.1` loopback redirect (RFC
   8252) — lift the loopback/PKCE/exchange helpers from `connections.ts`.
   The app is a PUBLIC client: no secret in the bundle. Access token in
   memory only; refresh token as `vaultStore` ciphertext (vault.ts). Refresh
   is serialized per account via a promise map (the ADR 0014:100-109
   pattern); the rotated refresh token is persisted on every renewal.
2. **DPoP (RFC 9449)**: every token request and every future entitlement call
   carries a signed DPoP proof JWT, sender-constraining the tokens to a key
   pair. This step generates the key in software (`src/backend/platform/
   dpop-key.ts`); step 06 swaps it for the hardware key. A refresh token
   lifted from the vault is then INERT without the private key.
3. **Contracts** (`src/contracts/ipc/account.ipc.ts` + `AccountChannels` in
   `channels.ts`, spread into `AllChannels`): `account:status -> { state:
   'anon'|'authed', email?, plan? }` · `account:login` · `account:logout`.
   A CLOSED shape. Assert by construction that NO channel returns an access
   or refresh token — the status carries identity + plan claims only.
4. **FAKE IdP** (`src/backend/features/account/fake-idp.ts`, fixture-driven):
   a deterministic in-process authorization server covering login success,
   user-cancel, expired-code, refresh-rotation, and revoked-refresh. Smokes
   and the gallery run ONLY this — zero network, ever. The real IdP is the
   operator's later wiring.
5. **ACCOUNT smoke** (`MOGGING_ACCOUNT`, env-gated, qa-smokes.sh row): on the
   FAKE IdP — (a) login lands an authed status with the right email; (b) the
   refresh token is at rest as ciphertext and NO channel returns it (grep the
   result + assert the IPC surface); (c) refresh rotates and persists; (d) a
   revoked refresh drops to `anon` cleanly; (e) a DPoP proof is attached and
   verifies; (f) logout clears vault + memory. Verdict
   `out/account-result.json`.

## Files
- `src/main/account.ts` · `src/backend/platform/dpop-key.ts` ·
  `src/contracts/ipc/account.ipc.ts` · `contracts/ipc/channels.ts`
  (+AllChannels) · `src/backend/features/account/fake-idp.ts` ·
  `src/main/account-smoke.ts` · main dispatch · `scripts/qa-smokes.sh`

## Definition of Done
- ACCOUNT green; the sweep count grows by one in the books.
- Login/logout work end to end on the FAKE IdP; tokens live only as
  ciphertext / in memory; grep proves no token in logs/telemetry/result.
- The account is inert on another machine's copy IN PRINCIPLE (DPoP key not
  yet hardware-bound — step 06 closes that).

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps (account.ts is
  main-only; UI sees contracts + IPC only); static gates; full sweep +
  ACCOUNT.

## Guardrails
- ADR 0002: our account only — no provider credential touched.
- No token getter on any channel — the write-only discipline holds.
- Login/refresh are user-initiated + async — never on the boot path (I7).
- Zero network in the smoke; protocol stays v9.
