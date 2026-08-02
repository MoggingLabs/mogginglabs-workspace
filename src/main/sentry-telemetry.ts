import * as Sentry from '@sentry/electron/main'
import { homedir } from 'node:os'
import { scrubBreadcrumb, scrubSentryEvent, type ScrubbableBreadcrumb, type ScrubbableEvent } from '@contracts'
import type { Breadcrumb, Telemetry, TelemetryEvent, TelemetryProps } from '@contracts'

interface SentryOpts {
  dsn: string
  environment: string
  release?: string
}

/**
 * Real Sentry error/crash adapter (opt-in), implementing the vendor-agnostic Telemetry port.
 * Confines the `@sentry/electron` import to the app layer (never a feature). The beforeSend
 * scrubber is the backstop for ADR 0005/0002: strip anything that could carry terminal output,
 * paths, env, or credentials — features only ever pass PRIMITIVE props, so events stay clean by
 * construction; this is defence in depth.
 */
export function createSentryTelemetry(opts: SentryOpts): Telemetry & { setEnabled(on: boolean): void } {
  return {
    /** Consent revoke/re-grant without restart: the SDK's global handlers stay
     *  installed, but a disabled client sends nothing. */
    setEnabled(on: boolean): void {
      const client = Sentry.getClient()
      if (client) client.getOptions().enabled = on
    },
    init(): void {
      Sentry.init({
        dsn: opts.dsn,
        environment: opts.environment,
        release: opts.release,
        sendDefaultPii: false,
        // ADR 0005 requires BOTH hooks. This one deleted three top-level fields and nothing
        // else, and the other did not exist — so the SDK default console integration attached
        // whatever the app had logged, and this repo logs absolute paths as a matter of course.
        beforeSend(event) {
          return scrubSentryEvent(event as unknown as ScrubbableEvent, homedir()) as unknown as typeof event
        },
        // Renderer breadcrumbs arrive PRE-EMBEDDED in event.breadcrumbs[] and never reach this
        // hook, which is why beforeSend walks them too.
        beforeBreadcrumb(crumb) {
          return scrubBreadcrumb(crumb as ScrubbableBreadcrumb, homedir()) as unknown as typeof crumb | null
        }
      })
    },
    captureError(error: unknown, context?: TelemetryProps): void {
      Sentry.captureException(error, context ? { extra: { ...context } } : undefined)
    },
    captureEvent(event: TelemetryEvent): void {
      Sentry.captureMessage(event.name, { level: 'info', extra: event.props })
    },
    addBreadcrumb(crumb: Breadcrumb): void {
      Sentry.addBreadcrumb({ category: crumb.category, message: crumb.message, level: crumb.level, data: crumb.data })
    },
    setContext(key: string, value: TelemetryProps): void {
      Sentry.setContext(key, value)
    },
    async flush(timeoutMs = 2000): Promise<void> {
      await Sentry.flush(timeoutMs)
    }
  }
}
