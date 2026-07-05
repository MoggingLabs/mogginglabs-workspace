import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UpdateChannels, type UpdateState } from '@contracts'
import { getTelemetry } from '@backend'

// App-wiring: auto-update via electron-updater against the signed GitHub Releases feed
// (electron-builder.yml `publish`). Runs ONLY in a packaged build — never in dev/smokes. It
// downloads a newer SIGNED build in the background and installs it on quit; electron-updater
// verifies the update's signature, so an unsigned/tampered build is rejected. Errors are
// reported via telemetry as BOOLEANS/ids only (ADR 0005), never fatal.
//
// Phase-6/06: the lifecycle is pushed to the renderer over UpdateChannels.state so the UI can
// show a quiet downloading dot + a single "ready — restart?" toast. A `MOGGING_FAKE_UPDATE`
// env drives the SAME renderer flow in dev/smokes without the updater ever touching a network.

let getWin: (() => BrowserWindow | null) | null = null

function push(state: UpdateState): void {
  getWin?.()?.webContents.send(UpdateChannels.state, state)
}

export function initAutoUpdate(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter

  // "Restart now" from the ready toast. In a fake-update run there is nothing to
  // install — the renderer just stops showing the toast; guard so the smoke's
  // click can't quit the app.
  ipcMain.handle(UpdateChannels.restart, () => {
    if (app.isPackaged && !process.env.MOGGING_FAKE_UPDATE) autoUpdater.quitAndInstall()
  })

  // Dev/smoke driver: replay the whole lifecycle to the renderer, no network.
  const fake = process.env.MOGGING_FAKE_UPDATE
  if (fake) {
    // Wait for the window's first paint so the renderer's listener is attached.
    const run = (): void => {
      push({ phase: 'checking' })
      setTimeout(() => push({ phase: 'available', version: fake }), 500)
      // Deliberately unhurried so the downloading dot stays observable across a
      // smoke's other steps (the real flow is minutes; this replays the shape).
      let pct = 0
      const tick = setInterval(() => {
        pct += 10
        if (pct >= 100) {
          clearInterval(tick)
          push({ phase: 'downloading', version: fake, percent: 100 })
          setTimeout(() => push({ phase: 'ready', version: fake }), 500)
        } else {
          push({ phase: 'downloading', version: fake, percent: pct })
        }
      }, 1200)
    }
    const win = winGetter()
    if (win && !win.webContents.isLoading()) setTimeout(run, 1500)
    else win?.webContents.once('did-finish-load', () => setTimeout(run, 1500))
    return
  }

  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) => push({ phase: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => push({ phase: 'idle' }))
  autoUpdater.on('download-progress', (p) =>
    push({ phase: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => push({ phase: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    // Human reason to the UI (never a stack); telemetry gets the boolean.
    push({ phase: 'error', error: 'update check failed' })
    getTelemetry().captureError(err, { feature: 'updater', op: 'check', platform: process.platform })
  })

  void autoUpdater.checkForUpdatesAndNotify()
  // Re-check periodically for long-running sessions.
  setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 6 * 60 * 60 * 1000)
}
