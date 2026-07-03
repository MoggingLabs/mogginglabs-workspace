Usage tracking starts at the SEAM, not the UI. Build the provider-adapter core
that reads plan usage (session window, weekly window, credits where a provider
has them) by riding the sessions the CLIs already own — and codify that stance
as an ADR before any adapter ships.

## Steps
1. **ADR 0007 — usage rides existing sessions** (`docs/adr/`): usage adapters
   read the token/session the provider's OWN CLI already stores (e.g. the
   credential files under the CLI's config home), use it in memory for the one
   usage request, and never persist, copy, log, or display it. A profile
   (Phase-4 pointer sets) selects WHICH config home is read — accounts switch
   without credentials moving. Explicitly forbid: token caching beyond the
   request, writing to any CLI's store, shipping usage values into telemetry
   (ADR 0005 companion note).
2. **Contracts** (`@contracts/usage`): `UsageWindow { label, usedPct, resetsAt,
   raw? }`, `PlanUsage { providerId, profileId, planLabel, windows[], credits?,
   fetchedAt, health: 'fresh'|'stale'|'error'|'unconfigured' }`, and the
   adapter interface `UsageAdapter { id, detect(home), fetch(home, signal) }`.
   Closed unions, no `any`, versioned like other contracts.
3. **Backend seam** (`@backend/features/usage`): adapter registry + a poller
   (per-provider cadence, jittered, backoff on error, paused while the window
   is hidden — main pushes visibility). Cache the LAST GOOD snapshot with its
   `fetchedAt`; stale is a first-class state, not an error. IPC surface:
   `usage:list` (snapshot) + `usage:refresh` + a push event on change.
4. **The FAKE adapter first**: deterministic fixtures (fed by env var payload
   or fixture file) covering: mid-window normal, near-limit, exhausted,
   fresh-reset, stale, error, unconfigured. Smokes and the gallery run ONLY
   this adapter — zero network in smokes, ever.
5. **Claude adapter**: read the Claude CLI's credential/config home (per-OS
   path table), call its usage/limits endpoint with the in-memory token,
   normalize to `PlanUsage` (5h session window + weekly window + resets).
   Handle: no CLI installed, logged-out store, expired token → `unconfigured`
   / `error` with a human `reason`, never a throw into the UI.
6. **USAGE smoke** (`MOGGING_USAGE`, env-gated, wired into qa-smokes.sh):
   boots on the FAKE adapter, asserts snapshot shape, cadence/backoff behavior
   (fake timers or short cadence), stale-after-error transition, and that the
   poller stops when hidden. Verdict via `out/usage-result.json`.

## Files
- `docs/adr/0007-usage-rides-existing-sessions.md` · `src/contracts/usage/` ·
  `src/backend/features/usage/` (registry, poller, fake + claude adapters) ·
  `src/main/usage-smoke.ts` · `scripts/qa-smokes.sh` (new gate row)

## Definition of Done
- USAGE gate green in the sweep; the sweep count grows by one everywhere the
  books mention it.
- Claude usage loads for a real logged-in CLI in dev (manual check) on the
  dev machine; absent/logged-out CLIs degrade to labeled states, not errors.
- Grep-clean: no token value ever appears in logs, telemetry calls, or the
  result JSON.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean (adapters are
  backend-only; UI sees contracts + IPC exclusively).
- Full local sweep including the new gate.

## Guardrails
- ADR 0002/0007 verbatim: in-memory, single-request token use; adapters read
  KNOWN per-CLI locations only — no filesystem crawling.
- No new daemon wire surface (protocol stays v3).
- Backoff, never hammer: an erroring provider dims to stale; retries are
  jittered exponential, capped.
- The FAKE adapter is a first-class citizen forever — every future usage
  feature must be exercisable without network.
