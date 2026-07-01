import { NoopTelemetry, setTelemetry } from '@ui/core/telemetry'
import type { TelemetryConfig } from '@contracts'

// Composition root for RENDERER observability. Today it installs the no-op adapter.
// When wiring real telemetry (see prompts/observability/), construct the Sentry
// (@sentry/electron/renderer) [+ optional posthog-js] adapter here, gated by `config`.
// Keep vendor SDK imports confined to this file — never in UI features.
export function initRendererTelemetry(_config?: TelemetryConfig): void {
  // TODO(observability/01,02): if _config?.enabled -> build the real adapter; else no-op.
  setTelemetry(new NoopTelemetry())
}
