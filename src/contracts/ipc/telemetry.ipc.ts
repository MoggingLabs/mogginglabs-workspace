// Telemetry IPC shapes (observability/00-02, ADR 0005). The renderer NEVER reads
// consent files or talks to a vendor network directly for analytics — it asks main for
// the resolved config and forwards curated product events over the channel; main owns
// the anonymous install id and every vendor client. OPT-IN: everything defaults off.

/** User consent, persisted main-side (app-settings store). Both default FALSE. */
export interface TelemetryConsent {
  /** Sentry error/crash reporting. */
  errorReporting: boolean
  /** PostHog product analytics (anonymous install id, curated events only). */
  productAnalytics: boolean
}

/** Resolved config the renderer may know. The install id deliberately stays in main. */
export interface TelemetryRendererConfig extends TelemetryConsent {
  environment: 'development' | 'production'
  release?: string
}

/** A product event forwarded renderer -> main. Names are dot.namespaced and props are
 *  primitives only — never user text, paths, commands, or terminal content. */
export interface TelemetryEventPayload {
  name: string
  props?: Record<string, string | number | boolean>
}
