Close Part II (the PRODUCT side): one composed milestone proving the whole
product promise on the LOCAL REAL stack offline, the CHECKLIST verified
through Parts I–II, and the operator money-step runbook written.
V1MILESTONE is the authority on "launch-ready except the operator's
spend." (Part III + the pack freeze land at 25.)

## Steps
1. **V1MILESTONE smoke** (`MOGGING_V1MILESTONE`, dispatch branch,
   qa-smokes row): ONE fixture world, app bound to the REAL backend
   (09–11) on `127.0.0.1` with a FAKE IdP subject + FAKE Stripe delivery —
   zero network — proving in journey order:
   anon FREE opens offline and the `mogging` wedge works → PKCE login via
   the real IdP seam (authed ≠ paid) → a signed Stripe webhook (forged one
   refused) activates server-side → the backend issues a device-bound,
   watermarked Ed25519 claim → caps widen (**Free 2x4 → Pro unlimited x16,
   `TIERS.md`**) → an **annual switch** re-derives the same grant → the
   **`maxDevices` cap refuses a 4th device**, revoking one frees it →
   **portal cancel reverts to Free at period-end, not mid-period** →
   network pulled: Pro holds through grace then degrades to Free, never
   bricking → a different device reads Free → a tampered build withholds
   Pro while Free runs → revoke → next refresh Free → logout → anon-free,
   wedge untouched. Both budgets measured here. Verdict
   `out/v1milestone-result.json`.
2. **CHECKLIST verified (Parts I–II)**: walk those sections; every
   non-money box checked or PENDING-operator with its reason; the ONLY
   open money items are signing (Apple + Windows) + the operator
   account/deploy steps, each named + costed. Part III + the full-pack
   verify are 25's job. Nothing silently unchecked.
3. **The operator money-step runbook** (`docs/25-going-live.md`): the
   ordered flip the founder does AFTER this pack — buy certs + CI secrets
   (`signing-dryrun`→`Release`), stand up the IdP + deploy the backend to
   Vercel/Neon with pinned config, submit winget/homebrew from signed
   artifacts, publish the legal docs, open Stripe checkout + configure its
   Customer Portal. Each: cost, what it unblocks, how to verify.
4. **Release dry-run**: `signing-dryrun` + `verify-signing-readiness` +
   the update-feed-resolves check unsigned; confirm packaging is a
   secrets-only change; record the READY line.
5. **Product-side certification** (pack README, Part-II section): the
   Part-I/II gate table all ✅, the measured numbers, the honest table —
   targeted gates green locally; the FULL three-OS sweep + prod deploy
   stay PENDING-operator. The freeze + `docs/02`/`prompts/README.md` rows
   land at 25.

## Files
- `smokes/v1milestone-smoke.ts` · `scripts/qa-smokes.sh` ·
  `docs/25-going-live.md` · `docs/02` · `prompts/README.md` · pack README
  · `CHECKLIST.md` (final verify)

## Definition of Done
- V1MILESTONE green on the local real stack offline; budgets held.
- Every Part-I/II CHECKLIST item checked or PENDING-operator-with-reason;
  the only money items are signing + operator accounts, named + costed.
- `docs/25-going-live.md` has the product-flip section (ordered + costed;
  25 adds the web section); the signing dry-run prints READY.
- The certification table is honest: local gates ✅, CI-OS + real deploy
  PENDING.

## Checks that must be green
- `npm run typecheck` → 0; build ok; the FULL static battery; V1MILESTONE +
  PRODMILESTONE + MILESTONE + PERCEPTION + every Part-II gate in one run;
  `server-ci`; gate-count re-derived and every prose count matching it.

## Guardrails
- The milestone composes existing machinery — nothing lands here a step
  gate didn't own.
- PENDING-operator rows stay PENDING; never claim a signed build, a
  three-OS sweep, or a deploy that wasn't run.
- The composed run is offline on loopback; a network dependency here is a
  defect.
