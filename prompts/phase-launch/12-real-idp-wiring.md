Make login REAL. Replace the FAKE Authorization Server with the chosen
IdP's real contract in `account.ts` — per ADR 0019, identity only; the
DPoP-bound access token comes from OUR backend (11). The FAKE stays as the
gate driver, and a parity gate proves the real path and the FAKE behave
identically, so every existing account gate keeps meaning what it meant.

## Steps
1. **The IdP seam** (`src/main/account.ts` + `src/backend/features/
   account/`): behind the SAME interface the FAKE implements, add the real
   IdP adapter (Auth.js/Clerk per ADR 0019) — RFC 8414 discovery
   (discover-then-pin), JWKS fetch for `id_token` verification (OIDC Core
   §3.1.3.7, alg allowlist,
   `iss`/`aud`/`exp`, verified-or-absent for reachability), PKCE(S256) in
   the system browser + the ephemeral loopback (already built). Identity
   only — the `id_token` establishes WHO; authorization never derives from
   it.
2. **Token exchange at our backend**: after IdP login, exchange the
   identity for OUR DPoP-bound access token at `server/` (11's token
   path), so the shipped DPoP dance + entitlement `ath` binding are
   unchanged. The refresh/rotation, the transient-vs-definitive session
   law (5xx/429 keep, 4xx ends), and "no token over IPC" all hold as-is.
3. **Origin pinning** (`origins.ts`): the real IdP + backend + issuer
   origins land as in-code literals (ORIGINPIN — never env-repointable);
   `config === null` stays the honest "not wired" state until the operator
   sets the real values, and login says so.
4. **IDPPARITY gate** (`MOGGING_IDPPARITY`, qa-smokes row): drive login,
   refresh, logout, id_token-invalid, and JWKS-unreachable against BOTH
   the FAKE and a LOCAL stub of the real adapter's contract — assert
   identical observable behavior (same session outcomes, same refusal
   sentences, same custody surface). Zero external network — the stub
   answers on loopback. Verdict `out/idpparity-result.json`.
5. **Wording**: `check-credential-wording.mjs` grows patterns so no copy
   claims "no account, ever" now that an optional account exists — while
   the FREE-core-account-free promise stays exact.

## Files
- `src/main/account.ts` · `src/backend/features/account/` (real adapter,
  FAKE kept) · `src/backend/core/origins.ts` · `smokes/idpparity-smoke.ts`
  · `scripts/qa-smokes.sh` · `scripts/check-credential-wording.mjs` ·
  `CHECKLIST.md` (mark 12)

## Definition of Done
- The real IdP adapter exists behind the FAKE's interface; `id_token`
  verified against JWKS; the DPoP-bound access token is minted by OUR
  backend (authN/authZ split honored).
- IDPPARITY green: real-contract stub and FAKE produce identical outcomes
  across login/refresh/logout/invalid/unreachable — offline.
- ORIGINPIN holds (origins are in-code); "not wired" is honest until the
  operator sets config; the wording gate passes.
- Every existing account/entitlement gate green unchanged.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; ACCOUNT + the
  entitlement gates + PRODMILESTONE in isolation; IDPPARITY; wording gate;
  both budgets unmoved.

## Guardrails
- The IdP does identity ONLY; DPoP/authZ stays at our backend — do not
  reach for an IdP feature that reopens the shipped design.
- No token crosses IPC; the account surface stays status/login/logout/
  changed. Gates stay offline (loopback stub).
- Real origins are pinned in code, never env (ORIGINPIN).
