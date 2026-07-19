The keystone: the endpoint that MINTS the signed entitlement — the authZ
authority the hardening wall trusts. A real Ed25519 claim, device-bound,
watermarked, graced, over the DPoP RS-nonce dance `entitlements.ts`
already expects. When this lands the app runs against a real backend on
loopback, offline, and PRODMILESTONE holds on real bytes.

> **Reconciled (ADR 0019):** a new Next.js route on the website's
> Neon/Vercel stack, not a greenfield `server/`; read `server/…` paths
> below as their route equivalents.

## Steps
1. **`GET /entitlement`** (`server/routes/entitlement.ts`): authenticate
   the access token; run the **RS-side DPoP nonce dance** (RFC 9449 §8.2 —
   one 401 + `DPoP-Nonce`, one retry) binding the proof to the token
   (`ath`); resolve the derived entitlement (10); return a **short-TTL
   Ed25519 JWT** (`typ: entitle+jwt`) carrying plan/features/limits, `exp`
   under the grace law, and — the pivot — the caller's **`deviceId`** (the
   DPoP key's RFC 7638 thumbprint), so the claim is sender-constrained to
   THIS machine. **Limits come from `TIERS.md` verbatim**; `features[]` is
   EMPTY at v1 — invent no flags, and mint no row for "unlimited" (an
   absent row fails open by contract).
2. **Device registry + cap** (`server/lib/devices.ts`): register the
   deviceId on first issuance, enforce **`maxDevices` (`TIERS.md`, Pro 3)**
   there — the only place it can be — record each in `events`, and support
   11a's revoke-a-device (a freed slot lands next refresh). A copied
   install presents a foreign key → the AS refuses its proofs → no claim
   issues to it (DEVICEKEY, now server-real).
3. **Watermark issuance** (`server/lib/watermark.ts`, sharing the
   `account/watermark.ts` codec pins): bind the per-account fingerprint
   into the signed claim (both carriers), ID-only, so a leaked activation
   attributes back — anti-forgery is the JWT's own signature.
4. **Keys + JWKS + revocation**: sign with the entitlement private key from
   ENV (13's keypair; its public half pinned in `origins.ts`); publish
   JWKS; honor server-side **revocation** (a `revoked` account → next
   issuance degrades to Free — latency = TTL, no detonation).
5. **The app-facing offline gate** (`V1ISSUE`, or extend the entitlement
   gate): boot the app at `server:dev` on `127.0.0.1`, FAKE IdP subject,
   and prove the round-trip — issue → device-bound Pro → caps widen →
   revoke → next refresh Free. Zero network; the FAKE keypair drives it.

## Files
- `server/routes/entitlement.ts` · `server/lib/{devices,watermark,
  signer}.ts` · `.well-known/jwks` · `server/test/` · a smoke binding the
  app to `server:dev` · `docs/21-backend.md` · `CHECKLIST.md` (mark 11)

## Definition of Done
- The endpoint mints a device-bound, watermarked `entitle+jwt` Ed25519
  claim under the DPoP RS dance; `entitlements.ts` verifies it against the
  pinned public key with zero code change.
- The claim matches `TIERS.md` exactly, `features[]` empty; `maxDevices`
  enforced at issuance; a foreign device cannot be licensed; revocation
  degrades on next refresh.
- The NEW `maxWorkspaces` row has a REAL app-side enforcement point —
  without it Free's cap fails open to Infinity.
- The app, offline against the local server, completes issue→Pro→revoke→
  Free by smoke; `server-ci` + the app smoke green.

## Checks that must be green
- `server` typecheck → 0; `server` vitest (issuance) green; the app smoke
  against `server:dev` in isolation; PRODMILESTONE green on the FAKE; both
  budgets unmoved.

## Guardrails
- The claim is the ONLY source of paid truth — signed, device-bound,
  server-authoritative (ADR 0016 §5); the client never self-grants.
- Private keys come from ENV and never commit; only the public half pins
  (13). Offline gate, always.
- No remote kill switch — revocation is refusal-to-reissue.
