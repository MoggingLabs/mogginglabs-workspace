import * as Sentry from '@sentry/electron/main'
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
export function createSentryTelemetry(opts: SentryOpts): Telemetry {
  return {
    init(): void {
      Sentry.init({
        dsn: opts.dsn,
        environment: opts.environment,
        release: opts.release,
        sendDefaultPii: false,
        beforeSend(event) {
          const e = event as unknown as Record<string, unknown>
          delete e.server_name // hostname
          delete e.user
          delete e.request // urls / headers / env
          return event
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
