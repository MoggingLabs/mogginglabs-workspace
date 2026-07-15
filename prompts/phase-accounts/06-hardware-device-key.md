This is the step that makes a copied install worthless. Bind the account's
DPoP key to a NON-EXPORTABLE hardware key — TPM on Windows, Secure Enclave
on macOS — so the entitlement is sender-constrained to THIS physical
machine. A copy on another laptop cannot refresh and cannot re-license.

## Steps
1. **`src/backend/platform/device-key/`** — a native addon (or vetted
   binding) exposing generate / sign / public-key, keys NON-EXPORTABLE by
   construction: Windows → CNG **Platform Crypto Provider** (TPM) or
   DPAPI-NG; macOS → **Secure Enclave** (`kSecAttrTokenIDSecureEnclave`);
   Linux → TPM 2.0 where present, else a `safeStorage`-wrapped software key
   with an HONEST documented downgrade (the vault's own `basic_text`
   precedent, vault.ts:13-25 — refuse to overclaim). Built from source
   against Electron's ABI — it JOINS node-pty/better-sqlite3 in
   `native-preflight.ts` and the rebuild set (README:146-160).
2. **Swap the DPoP key** (step 04's `dpop-key.ts`) to sign with the hardware
   key. The private key never leaves the TPM/Enclave; the app asks the chip
   to sign each proof. On hardware without a key store, fall back to
   software with the state surfaced honestly (Linux caveat), never silently.
3. **Device attestation at issuance** (`entitlements.ts`, step 05): the
   entitlement request includes the device public key; the (FAKE, then real)
   issuer binds `deviceId` to it and sender-constrains the entitlement. On
   verify, the app checks the entitlement's `deviceId` matches THIS device
   key — a mismatch (a copied vault on new hardware) fails, so no fresh
   entitlement is granted and the cached one expires to Free.
4. **Per-OS reality check** (invariant I5): the addon compiles and the smoke
   passes on Windows + macOS; Linux exercises the honest software-fallback
   path. Document all three in docs/18. All key ops are async, cached,
   post-boot (I7).
5. **DEVICEKEY smoke** (`MOGGING_DEVICEKEY`, qa-smokes.sh, FAKE issuer): (a)
   generate → sign → verify with the platform key; (b) the key is
   non-exportable (export attempt refused/absent); (c) a DPoP proof signed by
   device A is REJECTED when presented as device B (the copied-install case);
   (d) device-mismatch entitlement → no re-license → degrades to Free; (e)
   the Linux software fallback reports its weaker state, never claims
   hardware. Verdict `out/devicekey-result.json`.

## Files
- `src/backend/platform/device-key/` (addon + binding) ·
  `src/backend/platform/dpop-key.ts` (hardware swap) ·
  `src/main/entitlements.ts` (attestation) · `src/main/native-preflight.ts`
  (addon in the dlopen set) · `docs/18-accounts.md` (per-OS) ·
  `src/main/devicekey-smoke.ts` · qa-smokes.sh

## Definition of Done
- DEVICEKEY green; the sweep count grows by one.
- A copied, logged-in install moved to another machine CANNOT refresh or
  re-license — it degrades to Free (device-mismatch proven).
- Windows + macOS use non-exportable hardware keys; Linux degrades honestly.

## Checks that must be green
- `npm run typecheck` → 0; build ok; `native-preflight` dlopens the new
  addon at boot; static gates; full sweep + DEVICEKEY on Win + macOS.

## Guardrails
- The private key is non-exportable — no code path exfiltrates it.
- Honest fallback over false security — Linux says what it is.
- One new native addon, justified; it obeys the ABI-rebuild rule. Protocol
  stays v9; no network in the smoke.
