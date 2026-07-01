import { app } from 'electron'
import { NoopTelemetry, setTelemetry } from '@backend'
import type { TelemetryConfig } from '@contracts'
import { createSentryTelemetry } from './sentry-telemetry'

// Composition root for MAIN-process observability. OPT-IN (ADR 0005): the default is the no-op
// adapter; the real Sentry adapter is constructed ONLY when the user has consented AND a DSN is
// present (injected via SENTRY_DSN at build/run). The vendor SDK import stays confined to
// sentry-telemetry.ts — never in a feature.
export function initMainTelemetry(config?: TelemetryConfig): void {
  const resolved = config ?? resolveConfig()
  const dsn = process.env.SENTRY_DSN
  if (resolved.enabled && resolved.errorReporting && dsn) {
    const adapter = createSentryTelemetry({ dsn, environment: resolved.environment, release: resolved.release })
    void adapter.init()
    setTelemetry(adapter)
  } else {
    setTelemetry(new NoopTelemetry())
  }
}

// Consent + build env. OPT-IN — disabled unless the user opted in. A persisted consent setting
// lands with the observability feature; until then MOGGING_TELEMETRY=1 enables it.
function resolveConfig(): TelemetryConfig {
  const consent = process.env.MOGGING_TELEMETRY === '1'
  return {
    enabled: consent,
    errorReporting: consent,
    productAnalytics: false,
    environment: app.isPackaged ? 'production' : 'development',
    release: app.getVersion()
  }
}
