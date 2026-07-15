Entitlement is a SIGNED CLAIM the app verifies locally, not a boolean the
UI trusts. Fetch a short-lived Ed25519-signed entitlement, verify it with a
pinned public key, cache it, honor an offline grace, and expose ONE port
every gated feature reads. FAKE issuer only.

## Steps
1. **`src/main/entitlements.ts`** — fetch the entitlement JWT (authn: the
   step-04 access token + a DPoP proof), verify its signature LOCALLY with
   the Ed25519 PUBLIC KEY pinned in `origins.ts` (step 01 — never env, never
   fetched). Claims: `{ plan, features[], limits{}, deviceId, exp }`, TTL
   24–72h. Cache the ciphertext via `vaultStore`; refresh opportunistically
   in the background (post-paint, never boot — I7).
2. **The offline-grace law** (ADR 0015): honor a cached entitlement up to
   7–30 days past `fetchedAt`, THEN degrade to Free. Track `graceState:
   'fresh'|'grace'|'expired'`. Pulling the network must never brick — Pro
   holds through grace, then the app keeps running as Free. A tampered or
   wrong-signature JWT is treated as absent (→ Free), never trusted.
3. **The `Entitlements` port** (`@contracts` + injected in `src/main` like
   the Telemetry port, telemetry.ts pattern): features call
   `entitlements.allows('feature')` and `entitlements.limit('maxPanes')`.
   NO feature imports a token or the vendor; they see the port only. Snapshot
   IPC: `entitlements:snapshot -> { plan, features, limits, graceState }` +
   an `entitlements:changed` push. Claims cross IPC; secrets do not.
4. **Wire the first gate points** (mechanism only — WHICH tier gets what is a
   config table, not hard-coded): a panes-per-workspace cap (`MAX_PANES`),
   connections count (connections.ts), swarm role scale (features/agents),
   SSH remote panes (remotes.ts). Each reads the port; a blocked action
   returns the existing refusal grammar with a visible upgrade reason —
   NEVER a crash, NEVER a silent no-op. The free defaults are generous;
   `mogging list/send/capture` stay UNGATED (invariant I3).
5. **FAKE issuer** (`src/backend/features/account/fake-entitle.ts`): signs
   with a test keypair; fixtures for Free, Pro, expired, in-grace, tampered,
   device-mismatch (step 06 consumes the last). **ENTITLE smoke**
   (`MOGGING_ENTITLE`, qa-smokes.sh): assert verify-rejects-tampered,
   offline-grace holds then expires to Free, the port gates a capped
   feature, and a downgrade re-enables Free cleanly. Verdict
   `out/entitle-result.json`.

## Files
- `src/main/entitlements.ts` · `src/contracts/usage`-style `Entitlements`
  port + `entitlements.ipc.ts` · gate points (panes, connections, agents,
  remotes) · `src/backend/features/account/fake-entitle.ts` ·
  `src/main/entitle-smoke.ts` · qa-smokes.sh

## Definition of Done
- ENTITLE green; the sweep count grows by one.
- Offline: network pulled → Pro holds through grace → degrades to Free,
  never bricks. Tampered JWT → treated as Free.
- Gated features refuse with a visible upgrade reason; free tier + CLI
  verbs fully usable; both perf budgets unchanged.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; full sweep + ENTITLE;
  MILESTONE + PERCEPTION if any renderer gate point moved.

## Guardrails
- The public key is pinned in code (step 01) — a shipped build cannot be
  pointed at an attacker's signer.
- Local gates are UX, stated honestly — real teeth arrive in step 06.
- No boot-path work; zero network in the smoke; protocol stays v9.
