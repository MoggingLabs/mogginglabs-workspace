The last Part-I sweep: the conditions a lab never sees but a public user
hits on day one — a second OS, no network, a first launch, an upgrade
from a prior version, a starved machine, a dependency that fails. Prove
the app degrades HONESTLY everywhere, never silently, never with a lie.

## Steps
1. **Cross-OS parity**: walk the win/mac/linux matrix (docs/10). Confirm
   the same gate set passes on each (the nightly `macos-sweep`/
   `linux-sweep` + local windows), and that every path-separator, vault
   backend (`tpm`/`cng`/`secure-enclave`/`software`), and device-key
   custody row is HONEST about what it is (docs/19's per-OS table). The
   arm64-only mac note (Intel deferred) is stated, not hidden.
2. **Offline + degraded network**: launch with no network — free core
   works fully, login says "not available" honestly, entitlements read
   Free, the Brain is deterministic, updater feed failure is absorbed (the
   missing-feed boot-crash class stays fixed — assert it). Then flaky:
   5xx/429/timeout on every remote call keeps the session (transient law).
3. **First-run + upgrade/migration**: a clean install (no userData) boots
   to the wizard with zero stale state; an upgrade from an older schema
   (DB migrations, layout/persistence, vault format, Brain db
   `schema_version`) migrates forward without data loss and without a
   crash — test with a seeded old-version userData fixture. A downgrade
   refuses safely rather than corrupting.
4. **Low-resource + error-injection**: a starved box (few cores, low
   mem), a full disk on a DB write, a revoked keychain, a broken native
   module (`native-preflight` refuses to boot with the fix NAMED), a
   corrupt Brain db (rebuilds, never bricks). Each failure surfaces a
   human sentence, never a silent wrong state.
5. **Route + fix + derive**: EVERY finding (data loss on migration, a
   silent offline lie, a boot crash are S1; nits are S3) fixed here with an
   assertion — no `defer`. The environment lens then derives **A** on every
   INVENTORY row (01 §3).

## Files
- The migration/offline/preflight product files fixed · new/extended
  first-run + migration + offline smokes · `FINDINGS.md` · `INVENTORY.md`
  (environment grades) · `CHECKLIST.md` (mark 07)

## Definition of Done
- The gate set passes on all three OSes (or the CI dispatch is queued and
  the local set green — Claude never claims a CI-OS pass it didn't run;
  mark it PENDING-operator honestly).
- Offline, first-run, and an old→new upgrade each proven by a smoke;
  migration is loss-free and bite-proven against a seeded old userData.
- Every degraded path emits an honest sentence; no silent wrong state
  survives; the missing-feed boot crash stays fixed.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static battery; LAUNCHAUDIT; MAINT;
  the first-run/migration/offline smokes in isolation; MILESTONE +
  PERCEPTION unmoved.

## Guardrails
- Honest degradation is the whole point — a feature that fails silently is
  an S1, not a nit.
- Never claim a three-OS pass Claude didn't execute; PENDING-operator rows
  stay PENDING with the exact dispatch named.
- Zero network in gates; the offline path IS the test, not an obstacle.
