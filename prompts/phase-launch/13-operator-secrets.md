The real keys. Everything so far verified against FAKE keypairs; this
step GENERATES the production secrets, custodies them, pins their public
halves, and signs the tamper manifest — all at $0 (key generation is
free). The private halves never touch the repo; only public halves and
signed artifacts land. This is the operator's crown jewels, made real and
made safe.

## Steps
1. **Generate the keys** (`scripts/gen-operator-keys.mjs`, offline,
   deterministic-free): the **entitlement signing keypair** (Ed25519 — the
   claim signer, 11), the **tamper-manifest signing keypair** (signs the
   runtime self-check manifest, `native-preflight.ts`), and any
   verify-key the watermark trace path needs. Output private halves to a
   gitignored `secrets/` (operator moves them to their secret store) and
   public halves + thumbprints to stdout for pinning. NOTHING private is
   ever written under version control (a gate greps for it).
2. **Custody + rotation runbooks** (`docs/22-operator-secrets.md`): where
   each private key lives (the backend host's secret manager / GitHub
   Actions secrets — never a file in the image), how it is injected (ENV,
   11's signer + 09's config), the rotation procedure (mint new keypair →
   ship the new PUBLIC half in an app update → dual-verify window →
   retire old), and the blast-radius of each key if leaked. A secret
   INVENTORY table: name, purpose, where it rests, who can read it, how to
   rotate.
3. **Pin the public halves** (`src/backend/core/origins.ts`): replace the
   FAKE pinned entitlement verify key + origins with the real public
   values as in-code literals (kept in `protectedStrings` so bytecode
   hides their LOCATION, honestly not their secrecy). The real issuer
   `iss`/`aud` become pinnable now (the verifier already tolerates them).
4. **Sign the tamper manifest**: build the signed manifest
   (`native-preflight.ts` consumes) over the shipped `bin/` shims +
   integrity signal, signed by the tamper key; the verify key pins in the
   app. Until the operator sets real config it stays inert (no manifest →
   no-op), exactly as shipped — now with a REAL signer available.
5. **OPSECRETS static gate** (`scripts/check-operator-secrets.mjs`,
   qa-smokes row): fails if any private key material is greppable in the
   repo, if a pinned public half doesn't match the manifest/JWKS it
   claims, or if the secret INVENTORY has an unaccounted entry. Verdict
   `out/opsecrets-result.json`.

## Files
- `scripts/gen-operator-keys.mjs` · `scripts/check-operator-secrets.mjs` ·
  `.gitignore` (secrets/) · `docs/22-operator-secrets.md` ·
  `src/backend/core/origins.ts` (real pinned publics) · manifest signer ·
  `scripts/qa-smokes.sh` · `CHECKLIST.md` (mark 13)

## Definition of Done
- The three keypairs generate offline; private halves are gitignored and
  documented as operator-store-only; public halves pin in `origins.ts`.
- OPSECRETS green and bite-proven (drop a fake private key into the tree →
  red; remove → green).
- The rotation runbook covers all keys with a dual-verify window; the
  secret INVENTORY is complete.
- The tamper manifest signs under the real key; the app verifies with the
  pinned verify key; still inert-until-configured, honestly.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; OPSECRETS; BYTECODE +
  FUSES + WATERMARK + the tamper gate green on the real pinned publics;
  gate-count re-derived.

## Guardrails
- A private key NEVER enters the repo — the gate enforces it, and a leak
  here is the worst outcome in the phase.
- Pinning hides LOCATION, not secrecy — do not describe the pinned key as
  hidden; it is public by design.
- Generation is $0 and offline; no service is called to make a key.
