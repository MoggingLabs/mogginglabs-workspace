import type { Breadcrumb, Telemetry, TelemetryEvent, TelemetryProps } from '@contracts'
import { NoopTelemetry } from './noop'

/**
 * Route a Telemetry call to the adapters whose CONSENT covers it.
 *
 * The app offers two independent permissions — error reporting and product analytics —
 * and the fan-out has to respect both. It used to send every call to every active
 * adapter, so with errorReporting ON and productAnalytics OFF (a combination the Settings
 * UI offers, and the one a privacy-minded user picks) every product event was still
 * uploaded to Sentry as an info-level message. Consent was enforced when CHOOSING the
 * adapters and then discarded when CALLING them.
 *
 * Routing here rather than inside each adapter is the whole point: an adapter cannot
 * violate consent by behaving, because the call never reaches it. Pure and Electron-free
 * so the invariant is pinned in tests/unit rather than argued about.
 */
export function compositeTelemetry(errors: Telemetry[], analytics: Telemetry[]): Telemetry {
  const all = [...new Set([...errors, ...analytics])]
  if (all.length === 0) return new NoopTelemetry()
  return {
    init(): void {
      for (const a of all) void a.init()
    },
    captureError(error: unknown, context?: TelemetryProps): void {
      for (const a of errors) a.captureError(error, context)
    },
    captureEvent(event: TelemetryEvent): void {
      for (const a of analytics) a.captureEvent(event)
    },
    // Breadcrumbs are the trail attached to a crash — error consent, not analytics.
    addBreadcrumb(crumb: Breadcrumb): void {
      for (const a of errors) a.addBreadcrumb(crumb)
    },
    // Context is metadata ON whatever an adapter may already send; it transmits nothing
    // by itself, so it reaches everyone that is active.
    setContext(key: string, value: TelemetryProps): void {
      for (const a of all) a.setContext(key, value)
    },
    async flush(timeoutMs?: number): Promise<void> {
      await Promise.all(all.map((a) => a.flush(timeoutMs)))
    }
  }
}
