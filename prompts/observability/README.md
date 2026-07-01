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
| 00 | `00-consent-and-config.md` | opt-in consent + `TelemetryConfig` source; factories select adapter vs noop by config; default OFF |
| 01 | `01-sentry.md` | `@sentry/electron` errors + native crashes wired in both processes, scrubbed; sourcemaps upload |
| 02 | `02-posthog.md` | *(optional)* `posthog-node` explicit-event analytics from main, opt-in, anonymous |

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
