import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { getTelemetry } from '@backend'

// App-wiring: auto-update via electron-updater against the signed GitHub Releases feed
// (electron-builder.yml `publish`). Runs ONLY in a packaged build — never in dev/smokes. It
// downloads a newer SIGNED build in the background and installs it on quit; electron-updater
// verifies the update's signature, so an unsigned/tampered build is rejected. Errors are
// reported via telemetry, never fatal.
export function initAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (err) => {
    getTelemetry().captureError(err, { feature: 'updater', op: 'check', platform: process.platform })
  })
  void autoUpdater.checkForUpdatesAndNotify()
  // Re-check periodically for long-running sessions.
  setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 6 * 60 * 60 * 1000)
}
