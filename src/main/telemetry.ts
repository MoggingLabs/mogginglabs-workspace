import { NoopTelemetry, setTelemetry } from '@backend'
import type { TelemetryConfig } from '@contracts'

// Composition root for MAIN-process observability. Today it installs the no-op adapter.
// When wiring real telemetry (see prompts/observability/), construct the Sentry
// (@sentry/electron/main) + optional PostHog (posthog-node) adapter here, gated by
// `config` (user consent + build env), with a beforeSend scrubber. Keep the vendor
// SDK imports confined to THIS file (and src/renderer/telemetry.ts) — never in features.
export function initMainTelemetry(_config?: TelemetryConfig): void {
  // TODO(observability/01,02): if _config?.enabled -> build the real adapter; else no-op.
  setTelemetry(new NoopTelemetry())
}
