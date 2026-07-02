# Observability — wiring Sentry (+ optional PostHog)

Sequenced task prompts to turn on real telemetry behind the vendor-agnostic seam that
already ships in the codebase. **Execute in order.** The seam (`Telemetry` port + no-op
adapters + composition-root factories) is done; these steps fill in the factories.

> Read `docs/adr/0005-observability-sentry-posthog.md` first. **Privacy is a hard
> constraint, not a nice-to-have.**

## What already exists (don't rebuild)
- Port: `src/contracts/observability/telemetry.ts` (`Telemetry`, `TelemetryConfig`, primitive `TelemetryProps`).
- Accessors: `src/backend/core/telemetry/`, `src/ui/core/telemetry/` (settable singleton, default `NoopTelemetry`).
- Factories to fill in: `src/main/telemetry.ts` (`initMainTelemetry`), `src/renderer/telemetry.ts` (`initRendererTelemetry`).
- Demonstrated use: `src/backend/features/terminal/pty.service.ts` (`captureError` on spawn failure).

## Sequence
| # | File | Gate |
|---|------|------|
| 00 | `00-consent-and-config.md` | **DONE**: consent (2 flags) + anonymous install id persisted in the app-settings store; `telemetry:*` channels (`getConfig`/`setConsent`/`event`/`configChanged`); Settings toggles apply LIVE; default OFF; `DO_NOT_TRACK` honored |
| 01 | `01-sentry.md` | **DONE** (sourcemap upload pending a DSN/org): `@sentry/electron` main+renderer behind the seam, `sendDefaultPii:false` + scrubber, revoke disables the client without restart; activates only with consent AND `SENTRY_DSN` |
| 02 | `02-posthog.md` | **DONE**: `posthog-node` in MAIN only (`src/main/posthog-telemetry.ts`), anonymous install id, explicit curated events (~18 across the UI, forwarded over `telemetry:event` with a main-side sanitizer), no autocapture/recording/person profiles; activates only with consent AND `MOGGING_POSTHOG_KEY` |

> Remaining to go live: provision a Sentry DSN + PostHog project key (env/build-time:
> `SENTRY_DSN`, `MOGGING_POSTHOG_KEY` [+ `MOGGING_POSTHOG_HOST` for EU]) and add the
> `@sentry/vite-plugin` sourcemap upload once the org exists. Everything else ships.

## Privacy stance (applies to every step)
- **Opt-in**, default `enabled: false`; visible toggle; honor `DO_NOT_TRACK`.
- Telemetry never sees terminal output, prompts, code, paths, env, or credentials.
- Primitives-only event props; Sentry `beforeSend`/`beforeBreadcrumb` scrubbers required.
- Anonymous local install id only; no PII, no provider identity.
- Vendor SDK imports stay confined to `src/main/telemetry.ts` + `src/renderer/telemetry.ts`.

## Global checks that must stay green
- `npm run typecheck` -> exit 0 (after each step)
- `npm run build` -> succeeds (sourcemaps emitted once 01 lands)
- With `enabled: false` (or `DO_NOT_TRACK`) -> **zero** network calls to Sentry/PostHog
- Boundary check: no `@sentry/*` or `posthog*` import outside the two telemetry factory files
