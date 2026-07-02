import { app, ipcMain, type BrowserWindow } from 'electron'
import { NoopTelemetry, setTelemetry, getTelemetry } from '@backend'
import {
  TelemetryChannels,
  type Breadcrumb,
  type Telemetry,
  type TelemetryConsent,
  type TelemetryEvent,
  type TelemetryProps,
  type TelemetryRendererConfig
} from '@contracts'
import { getSettingsStore } from './app-settings'
import { createSentryTelemetry } from './sentry-telemetry'
import { createPosthogTelemetry } from './posthog-telemetry'

// Composition root for MAIN-process observability (observability/00-02, ADR 0005).
// OPT-IN end to end: both consent flags default OFF in the settings store; DO_NOT_TRACK
// forces the no-op path regardless; vendor clients exist only while consented AND keyed
// (SENTRY_DSN / MOGGING_POSTHOG_KEY at build/run). Consent changes re-init LIVE:
// granting constructs the client, revoking disables Sentry's client + shuts PostHog
// down — nothing is sent after a revoke. All vendor SDK imports stay confined to the
// two adapter files; features only ever see the vendor-agnostic Telemetry port.

let sentry: (Telemetry & { setEnabled(on: boolean): void }) | null = null
let posthog: (Telemetry & { shutdown(): Promise<void> }) | null = null

/** Fan a Telemetry call out to every active adapter. */
function composite(adapters: Telemetry[]): Telemetry {
  if (adapters.length === 0) return new NoopTelemetry()
  return {
    init(): void {
      for (const a of adapters) void a.init()
    },
    captureError(error: unknown, context?: TelemetryProps): void {
      for (const a of adapters) a.captureError(error, context)
    },
    captureEvent(event: TelemetryEvent): void {
      for (const a of adapters) a.captureEvent(event)
    },
    addBreadcrumb(crumb: Breadcrumb): void {
      for (const a of adapters) a.addBreadcrumb(crumb)
    },
    setContext(key: string, value: TelemetryProps): void {
      for (const a of adapters) a.setContext(key, value)
    },
    async flush(timeoutMs?: number): Promise<void> {
      await Promise.all(adapters.map((a) => a.flush(timeoutMs)))
    }
  }
}

function rendererConfig(): TelemetryRendererConfig {
  const s = getSettingsStore()?.getTelemetrySettings()
  const dnt = !!process.env.DO_NOT_TRACK
  return {
    errorReporting: !dnt && !!s?.errorReporting,
    productAnalytics: !dnt && !!s?.productAnalytics,
    environment: app.isPackaged ? 'production' : 'development',
    release: app.getVersion()
  }
}

/** (Re)build the adapter set from persisted consent + env keys. Safe to call again. */
function applyConsent(): void {
  const cfg = rendererConfig()
  const store = getSettingsStore()
  const installId = store?.getTelemetrySettings().installId ?? ''
  const active: Telemetry[] = []

  const dsn = process.env.SENTRY_DSN
  if (cfg.errorReporting && dsn) {
    if (!sentry) {
      sentry = createSentryTelemetry({ dsn, environment: cfg.environment, release: cfg.release })
      void sentry.init()
    }
    sentry.setEnabled(true)
    active.push(sentry)
  } else {
    sentry?.setEnabled(false) // SDK handlers stay; a disabled client sends nothing
  }

  const phKey = process.env.MOGGING_POSTHOG_KEY || process.env.POSTHOG_KEY
  if (cfg.productAnalytics && phKey && installId) {
    if (!posthog) {
      posthog = createPosthogTelemetry({
        apiKey: phKey,
        host: process.env.MOGGING_POSTHOG_HOST,
        distinctId: installId,
        environment: cfg.environment,
        release: cfg.release
      })
    }
    active.push(posthog)
  } else if (posthog) {
    void posthog.shutdown() // flush + stop — nothing sent after revoke
    posthog = null
  }

  setTelemetry(composite(active))
}

/** Curate a renderer-forwarded event: dot.namespaced name, primitive props only,
 *  bounded sizes — defence in depth on top of the curated call sites. */
function sanitizeEvent(payload: unknown): TelemetryEvent | null {
  const p = payload as { name?: unknown; props?: unknown }
  if (typeof p?.name !== 'string' || !/^[a-z0-9_.:-]{1,64}$/i.test(p.name)) return null
  const props: TelemetryProps = {}
  if (p.props && typeof p.props === 'object') {
    let n = 0
    for (const [k, v] of Object.entries(p.props as Record<string, unknown>)) {
      if (n >= 20) break
      if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue
      if (typeof v === 'number' || typeof v === 'boolean') props[k] = v
      else if (typeof v === 'string') props[k] = v.slice(0, 200)
      else continue
      n++
    }
  }
  return { name: p.name, props }
}

/**
 * Initialize main-process telemetry from PERSISTED consent (call after
 * registerAppSettings) and register the telemetry IPC surface. Emits `app.launched`
 * (reaches a vendor only if the user opted in).
 */
export function initMainTelemetry(getWin?: () => BrowserWindow | null): void {
  applyConsent()

  ipcMain.handle(TelemetryChannels.getConfig, () => rendererConfig())

  ipcMain.handle(TelemetryChannels.setConsent, (_e, consent: TelemetryConsent) => {
    getSettingsStore()?.setTelemetryConsent({
      errorReporting: consent?.errorReporting === true,
      productAnalytics: consent?.productAnalytics === true
    })
    applyConsent()
    const cfg = rendererConfig()
    getWin?.()?.webContents.send(TelemetryChannels.configChanged, cfg)
    return cfg
  })

  ipcMain.on(TelemetryChannels.event, (_e, payload: unknown) => {
    const event = sanitizeEvent(payload)
    if (event) getTelemetry().captureEvent(event)
  })

  getTelemetry().captureEvent({
    name: 'app.launched',
    props: { environment: app.isPackaged ? 'production' : 'development' }
  })
}

/** Flush vendors on quit (no-ops when consent is off). */
export async function flushTelemetry(): Promise<void> {
  await getTelemetry()
    .flush(1500)
    .catch(() => undefined)
}
