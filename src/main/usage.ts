import { app, ipcMain, type BrowserWindow } from 'electron'
import { UsageChannels, type PlanUsage } from '@contracts'
import { createUsageService, fakeAdapter, claudeAdapter, type UsageService } from '@backend/features/usage'
import { getSettingsStore } from './app-settings'

// App-wiring: usage meters (Phase-7/01, ADR 0007). Adapter pick is the
// zero-network guarantee: under a usage smoke the registry holds ONLY the
// FAKE adapter; under any OTHER smoke it holds nothing (no poller traffic in
// unrelated gates); real adapters exist only in a real session. Main feeds
// the poller window visibility (hidden = paused) and fans snapshot changes
// out on one push channel. No token, path, or account id crosses this file.

let service: UsageService | null = null

/** Smoke hook: direct service access (main-side only). */
export function getUsageService(): UsageService | null {
  return service
}

export function registerUsage(getWin: () => BrowserWindow | null): void {
  const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))
  const isUsageSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_USAGE'))
  const adapters = isUsageSmoke ? [fakeAdapter] : isSmoke ? [] : [claudeAdapter]

  const cadenceEnv = Number(process.env.MOGGING_USAGE_CADENCE_MS)
  const cadenceMsOverride = Number.isFinite(cadenceEnv) && cadenceEnv > 0 ? cadenceEnv : isUsageSmoke ? 400 : undefined

  service = createUsageService({
    adapters,
    profiles: () => getSettingsStore()?.listProfiles() ?? [],
    kv: {
      get: (k) => getSettingsStore()?.getSetting(k) ?? null,
      set: (k, v) => getSettingsStore()?.setSetting(k, v)
    },
    onChange: (plans: PlanUsage[]) => getWin()?.webContents.send(UsageChannels.changed, plans),
    cadenceMsOverride
  })

  ipcMain.handle(UsageChannels.list, () => service?.list() ?? [])
  ipcMain.handle(UsageChannels.refresh, () => service?.refresh())

  // Hidden window = paused poller (poll politely). Single-window app: the
  // main window is the only BrowserWindow main creates.
  app.on('browser-window-created', (_e, w) => {
    w.on('hide', () => service?.setVisible(false))
    w.on('minimize', () => service?.setVisible(false))
    w.on('show', () => service?.setVisible(true))
    w.on('restore', () => service?.setVisible(true))
  })
  app.on('before-quit', () => service?.stop())
}
