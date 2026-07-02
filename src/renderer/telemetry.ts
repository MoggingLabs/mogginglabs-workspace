import * as Sentry from '@sentry/electron/renderer'
import { NoopTelemetry, setTelemetry } from '@ui/core/telemetry'
import { getBridge } from '@ui/core/ipc/bridge'
import {
  TelemetryChannels,
  type Breadcrumb,
  type Telemetry,
  type TelemetryEvent,
  type TelemetryProps,
  type TelemetryRendererConfig
} from '@contracts'

// Composition root for RENDERER observability (observability/01-02, ADR 0005).
// OPT-IN: main resolves persisted consent and hands the renderer a config over IPC —
// the renderer never reads files or holds the install id. Errors go through
// @sentry/electron/renderer (auto-forwarded to the main SDK, so one DSN + native
// crashes stay unified); PRODUCT EVENTS are forwarded over the telemetry channel to
// main, where the single PostHog client lives. Consent changes re-init live via
// telemetry:configChanged. This file is the renderer's ONLY vendor-SDK importer —
// features only ever call the vendor-agnostic port.

let sentryInited = false

function buildAdapter(cfg: TelemetryRendererConfig): Telemetry {
  const anyOn = cfg.errorReporting || cfg.productAnalytics
  if (!anyOn) return new NoopTelemetry()

  if (cfg.errorReporting && !sentryInited) {
    // Renderer init auto-forwards to main's SDK — no DSN needed here. Consent for the
    // whole pipeline is enforced in main (a disabled client sends nothing).
    Sentry.init({ sendDefaultPii: false })
    sentryInited = true
  }

  const forward = (event: TelemetryEvent): void => {
    try {
      getBridge().send(TelemetryChannels.event, { name: event.name, props: event.props })
    } catch {
      /* bridge unavailable — drop silently */
    }
  }

  return {
    init(): void {
      /* built above */
    },
    captureError(error: unknown, context?: TelemetryProps): void {
      if (cfg.errorReporting) {
        Sentry.captureException(error, context ? { extra: { ...context } } : undefined)
      }
    },
    captureEvent(event: TelemetryEvent): void {
      forward(event) // main routes to PostHog only while product analytics is consented
    },
    addBreadcrumb(crumb: Breadcrumb): void {
      if (cfg.errorReporting) {
        Sentry.addBreadcrumb({
          category: crumb.category,
          message: crumb.message,
          level: crumb.level,
          data: crumb.data
        })
      }
    },
    setContext(key: string, value: TelemetryProps): void {
      if (cfg.errorReporting) Sentry.setContext(key, value)
    },
    async flush(): Promise<void> {
      /* main owns vendor flushing */
    }
  }
}

/** Install the no-op immediately (UI can mount), then resolve consent over IPC and
 *  swap the real adapter in; re-init whenever main broadcasts a consent change. */
export function initRendererTelemetry(): void {
  setTelemetry(new NoopTelemetry())
  try {
    const bridge = getBridge()
    void bridge
      .invoke(TelemetryChannels.getConfig)
      .then((cfg) => setTelemetry(buildAdapter(cfg as TelemetryRendererConfig)))
      .catch(() => undefined)
    bridge.on(TelemetryChannels.configChanged, (cfg) =>
      setTelemetry(buildAdapter(cfg as TelemetryRendererConfig))
    )
  } catch {
    /* no bridge (tests) — stay no-op */
  }
}
