// Vendor-agnostic observability port. Backend and UI depend on THIS interface — never
// on Sentry/PostHog directly. Concrete adapters are constructed only at the composition
// root (src/main/telemetry.ts, src/renderer/telemetry.ts), so the vendor can be swapped
// or disabled without touching a single feature.
//
// PRIVACY (hard rule — see docs/adr/0005-observability-sentry-posthog.md):
// telemetry must NEVER receive terminal/PTY output, prompt text, code, file
// contents/paths, environment variables, or provider credentials. Event props are
// primitives only (which discourages dumping sensitive blobs); adapters add a scrubber
// as a backstop. Telemetry is OPT-IN.

export type TelemetryLevel = 'fatal' | 'error' | 'warning' | 'info'

/** Props are primitives only — no free-form objects, so sensitive blobs can't leak. */
export type TelemetryProps = Record<string, string | number | boolean>

export interface TelemetryEvent {
  /** dot.namespaced event name, e.g. 'workspace.opened'. Never user/terminal content. */
  name: string
  props?: TelemetryProps
}

export interface Breadcrumb {
  category: string
  message: string
  level?: TelemetryLevel
  data?: TelemetryProps
}

/** The capability features use to report errors and product events. */
export interface Telemetry {
  init(): void | Promise<void>
  captureError(error: unknown, context?: TelemetryProps): void
  captureEvent(event: TelemetryEvent): void
  addBreadcrumb(crumb: Breadcrumb): void
  setContext(key: string, value: TelemetryProps): void
  flush(timeoutMs?: number): Promise<void>
}

/** Resolved from user consent + build config at the composition root. */
export interface TelemetryConfig {
  /** master switch — false => NoopTelemetry regardless of the flags below. */
  enabled: boolean
  /** Sentry error/crash reporting. */
  errorReporting: boolean
  /** PostHog product analytics (opt-in, optional). */
  productAnalytics: boolean
  environment: 'development' | 'production'
  release?: string
}
