CodexBar surfaces provider incidents — a status dot in the menu, an overlay
on the bar icon — so a red gauge reads as "they're down," not "you're out."
Ours: a status feed on the same seam, public status endpoints only, badging
enabled providers. Research: `docs/research/2026-07-codexbar-parity.md`.

## Steps
1. **Status contract** (`@contracts/usage`): `ProviderStatus { providerId,
   state: 'operational'|'degraded'|'outage'|'unknown', note?, checkedAt }`.
   A provider row (04) optionally declares a `statusUrl` (a PUBLIC
   statuspage/health endpoint — no auth, no cookies).
2. **Status poller** (`@backend/features/usage/status.ts`): polls the
   `statusUrl` of ENABLED providers only, on ONE shared cadence, jittered,
   backoff on error, paused when hidden — the usage-poller's discipline,
   separate cadence (status changes slowly; default 5m). Normalizes common
   statuspage shapes (statuspage.io summary, generic up/down) to the enum;
   an unparseable/unreachable endpoint → `unknown`, never an error dialog.
3. **Tile + icon integration**: the popover tile (03) gains a status chip
   when non-operational; a provider in `outage` while its gauge is
   `error`/`stale` shows "provider outage" as the reason INSTEAD of a
   scary red — the meter distinguishes "you're out" from "they're down".
   The titlebar gauge gets a subtle incident overlay when any ENABLED
   provider is in outage (the attention-badge idiom, one glyph).
4. **IPC**: `usage:status` snapshot + a push event on change; wired under
   the same FAKE-under-smoke rule (status poller registers zero real
   endpoints under a usage smoke env).
5. **STATUS smoke** (folds into `MOGGING_USAGE`; no new gate): FAKE status
   fixtures (operational/degraded/outage/unknown) → assert normalization,
   that only enabled providers are polled, that outage reshapes a failing
   tile's reason, and that the icon overlay arms on any enabled outage.
   Zero network; assertions in the USAGE verdict JSON.

## Files
- `src/backend/features/usage/status.ts` + statusUrl catalog fields ·
  `src/contracts/usage/` (ProviderStatus) · `src/contracts/ipc` (usage
  channels grow) · `src/ui/features/usage/` (status chip + icon overlay) ·
  `src/main/usage.ts` · `src/main/usage-smoke.ts` · `src/main/gallery.ts`

## Definition of Done
- With a provider's real statuspage reachable in dev, an induced/observed
  incident shows the chip + overlay; an outage relabels that provider's
  failing tile as "provider outage," not a user error (books).
- Status polls only ENABLED providers, shares one jittered cadence, pauses
  when hidden.
- USAGE gate green (grown); sweep count unchanged.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundary greps clean.
- Full local sweep; both perf budgets re-run (icon overlay touches render).

## Guardrails
- Status endpoints are PUBLIC — no auth, no cookies, no keys; a row's
  statusUrl that isn't a plain health endpoint is refused in review.
- Poll politely: enabled-only, one shared cadence, jittered, backoff,
  hidden-pause — 50 providers must not mean 50 status hammers.
- Status text/incident detail never enters telemetry (ADR 0005) — the
  enum state + booleans only.
- The overlay is one subtle glyph, not a takeover — docs/11 icon rhythm.
