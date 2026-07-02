import { PostHog } from 'posthog-node'
import type { Breadcrumb, Telemetry, TelemetryEvent, TelemetryProps } from '@contracts'

interface PosthogOpts {
  apiKey: string
  host?: string
  /** The anonymous local install id (never account/machine/provider identity). */
  distinctId: string
  environment: string
  release?: string
}

/**
 * PostHog product-analytics adapter (opt-in — observability/02, ADR 0005). Runs in
 * MAIN only (the renderer forwards curated events over the telemetry channel), so this
 * file is the app's single `posthog*` importer. Events are explicit + curated: no
 * autocapture, no session recording, no person profiles — an anonymous install id and
 * primitive props, nothing else. Errors stay Sentry's job.
 */
export function createPosthogTelemetry(opts: PosthogOpts): Telemetry & { shutdown(): Promise<void> } {
  const client = new PostHog(opts.apiKey, {
    host: opts.host ?? 'https://us.i.posthog.com',
    flushAt: 10,
    flushInterval: 15000
  })

  return {
    init(): void {
      /* client is live on construction */
    },
    captureError(_error: unknown, _context?: TelemetryProps): void {
      /* errors are Sentry's concern */
    },
    captureEvent(event: TelemetryEvent): void {
      client.capture({
        distinctId: opts.distinctId,
        event: event.name,
        properties: {
          ...event.props,
          app_environment: opts.environment,
          ...(opts.release ? { app_release: opts.release } : {}),
          $process_person_profile: false // anonymous events — no person profiles
        }
      })
    },
    addBreadcrumb(_crumb: Breadcrumb): void {
      /* breadcrumbs are Sentry's concern */
    },
    setContext(_key: string, _value: TelemetryProps): void {
      /* no persistent person/context state in analytics */
    },
    async flush(_timeoutMs = 2000): Promise<void> {
      await client.flush()
    },
    async shutdown(): Promise<void> {
      await client.shutdown()
    }
  }
}
