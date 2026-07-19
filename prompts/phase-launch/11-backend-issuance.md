The keystone: the endpoint that MINTS the signed entitlement. This is the
authZ authority the whole hardening wall trusts — a real Ed25519 claim,
device-bound, watermarked, graced — served over the DPoP RS-nonce dance
the shipped `entitlements.ts` already expects. When this lands, the app
can run against a real backend on loopback, offline, and PRODMILESTONE's
promise holds on real bytes.

> **Reconciled (ADR 0019):** a new Next.js route on the website's
> Neon/Vercel stack (`../MoggingLabs-Website`), not a greenfield `server/`;
> read `server/…` paths below as their route equivalents.

## Steps
1. **`GET /entitlement`** (`server/routes/entitlement.ts`): authenticate
   the caller's access token; run the **RS-side DPoP nonce dance** (RFC
   9449 §8.2 — one 401 + `DPoP-Nonce`, one retry) and bind the proof to
   the token (`ath`); resolve the account's derived entitlement (from 10);
   and return a **short-TTL Ed25519 JWT** with `typ: entitle+jwt`, the
   plan/features/limits, `exp` under the grace law, and — the pivot — the
   caller's **`deviceId`** (the DPoP key's RFC 7638 thumbprint), so the
   claim is sender-constrained to THIS machine.
2. **Device registry + cap** (`server/lib/devices.ts`): register the
   deviceId on first issuance, enforce a per-plan device cap at issuance
   (the only place it can be enforced), and record each issuance in
   `events`. A copied install presents a foreign key → the AS refuses its
   proofs → no claim issues to it (the DEVICEKEY story, now server-real).
3. **Watermark issuance** (`server/lib/watermark.ts`, sharing the codec
   `src/backend/features/account/watermark.ts` pins): bind the per-account
   fingerprint into the signed claim (both carriers), ID-only, so a leaked
   activation attributes back — anti-forgery is the JWT's own signature.
4. **Keys + JWKS + revocation**: sign with the entitlement private key
   loaded from ENV (the real keypair 13 generates; the public half is the
   one pinned in `origins.ts`); publish JWKS for identity tokens; honor
   server-side **revocation** (a `revoked` account → the next issuance
   degrades to Free — revocation latency = the TTL, no remote detonation).
5. **The app-facing offline gate** (`V1ISSUE` smoke or an extension of the
   entitlement gate): boot the app pointed at `server:dev` on `127.0.0.1`,
   FAKE IdP subject, and prove the real round-trip — issue → device-bound
   Pro → a capped feature unlocks → revoke → next refresh Free. Zero
   external network; the FAKE keypair drives it, the real one is 13's.

## Files
- `server/routes/entitlement.ts` · `server/lib/{devices,watermark,
  signer}.ts` · `server/.well-known/jwks` · `server/test/` (issuance) ·
  a smoke binding the app to `server:dev` · `docs/21-backend.md`
  (issuance chapter) · `CHECKLIST.md` (mark 11)

## Definition of Done
- The endpoint mints a valid device-bound, watermarked, `entitle+jwt`
  Ed25519 claim under the DPoP RS dance; `entitlements.ts` verifies it
  against the pinned public key with zero code change.
- The device cap is enforced at issuance; a foreign device cannot be
  licensed; revocation degrades on next refresh (no detonation).
- The app, bound to the local real server offline, completes issue→Pro→
  revoke→Free — proven by a smoke, zero external network.
- `server-ci` + the app smoke green.

## Checks that must be green
- `server` typecheck → 0; `server` vitest (issuance) green; the app
  smoke against `server:dev` green in isolation; PRODMILESTONE still green
  on the FAKE; both budgets unmoved.

## Guardrails
- The claim is the ONLY source of paid truth — signed, device-bound,
  server-authoritative (ADR 0016 §5); the client never self-grants.
- Private keys come from ENV and never commit; only the public half is
  pinned (13). Offline gate, always.
- No remote kill switch — revocation is refusal-to-reissue, latency = TTL.
