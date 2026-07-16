Make leaks traceable and forks self-incriminating. Stamp each activation
with a per-account forensic fingerprint so a leaked license points back to
who leaked it, and add a runtime tamper self-check that withholds PAID
operations on a modified build — while the free app keeps running.

## Steps
1. **Forensic activation watermark** (`src/main/entitlements.ts` +
   `src/backend/features/account/watermark.ts`): at activation, bind a
   per-ACCOUNT fingerprint into the entitlement/activation record —
   distributed across benign carriers (a signed manifest field, stable
   ordering of non-semantic fields) so one surviving copy is enough to
   attribute. Extractable back to the account id by an operator tool
   (`scripts/trace-watermark.mjs`). ID ONLY — never a credential, never
   terminal content (invariant I6). This is the software analog of
   per-recipient forensic watermarking for leak attribution.
2. **Runtime tamper self-check** (extend `src/main/native-preflight.ts`,
   async post-paint — NEVER the boot critical path, I7): verify the app's
   own integrity signal and the unpacked `bin/` shims against a signed
   manifest. On mismatch, set a `tampered` flag that makes
   `entitlements.allows()` withhold PAID features — but the FREE app still
   runs fully (invariant I2). A patched fork can strip this check too, so it
   is evidence + a revocation trigger, not prevention; say so in docs/18.
3. **Opt-in piracy telemetry** (respect the existing consent model,
   telemetry.ts:16-23): emit a BOOLEAN `build.modified` signal (and
   `entitlement.device_mismatch`) so piracy RATE is measurable and abused
   licenses can be revoked server-side. No path, no filename, no id beyond
   the account already known to the authed session (ADR 0005).
4. **Server-side revocation hook** (contract only; the backend is the
   operator's): the app honors an entitlement `revoked` claim on next
   refresh — revocation latency = the entitlement TTL (step 05). No remote
   detonation of a running app; a revoked account simply gets no fresh
   entitlement and degrades to Free at grace-end.
5. **WATERMARK smoke** (`MOGGING_WATERMARK`, qa-smokes.sh, FAKE issuer): (a)
   a watermarked activation round-trips and `trace-watermark.mjs` extracts
   the exact account id; (b) a simulated tamper sets `tampered`, PAID
   features are withheld, and the FREE app still boots and runs +
   `mogging list` still works; (c) telemetry payloads are booleans only
   (grep); (d) a `revoked` entitlement degrades to Free on refresh. Verdict
   `out/watermark-result.json`.

## Files
- `src/backend/features/account/watermark.ts` · `src/main/entitlements.ts`
  · `src/main/native-preflight.ts` (tamper check) · `scripts/trace-
  watermark.mjs` · `docs/19-accounts.md` (honest-limit note) ·
  `src/main/watermark-smoke.ts` · qa-smokes.sh

## Definition of Done
- WATERMARK green; the sweep count grows by one.
- A leaked activation traces to its account; a tampered build loses PAID
  features but the FREE app keeps working (never bricks — I2).
- Piracy telemetry is opt-in and boolean-only; revocation lands at
  grace-end, no remote detonation.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; full sweep + WATERMARK;
  MILESTONE (self-check must be off the hot path).

## Guardrails
- ID and booleans only — never a credential or terminal content in a
  watermark or a telemetry call (ADR 0002/0005).
- The tamper check gates PAID ops only; the free tier is never withheld.
- Async post-paint; zero network in the smoke; protocol stays v9.
