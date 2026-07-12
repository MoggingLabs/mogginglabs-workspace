import fs from 'node:fs'
import path from 'node:path'
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
// The lifecycle is pushed to the renderer over UpdateChannels.state so the UI can show the
// rail's update row (and the ready toast). A `MOGGING_FAKE_UPDATE` env drives the SAME
// renderer flow in dev/smokes without the updater ever touching a network.

let getWin: (() => BrowserWindow | null) | null = null

function push(state: UpdateState): void {
  getWin?.()?.webContents.send(UpdateChannels.state, state)
}

/**
 * electron-updater ships with a no-op logger. That is how a feed whose every download 404'd
 * went unnoticed across nine releases: the renderer saw a generic `error`, and nothing on
 * disk recorded WHICH url failed. A plain appendFile logger (no new dependency) leaves the
 * breadcrumb next to the app's other state.
 *
 * Truncated past ~256KB so it cannot grow unbounded on a machine that has been checking
 * every six hours for a year.
 */
type UpdaterLog = { info(m: unknown): void; warn(m: unknown): void; error(m: unknown): void; debug(m: unknown): void }

function createUpdaterLog(): UpdaterLog {
  const file = path.join(app.getPath('userData'), 'updater.log')
  const write = (level: string, m: unknown): void => {
    try {
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 256 * 1024) fs.truncateSync(file, 0)
      const text = m instanceof Error ? (m.stack ?? m.message) : String(m)
      fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`)
    } catch {
      /* diagnostics must never be the reason the app fails */
    }
  }
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    debug: (m) => write('debug', m)
  }
}

export function initAutoUpdate(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter

  // "Restart now" from the ready toast / the rail's update row. In a fake-update run there
  // is nothing to install — the renderer just stops showing it; guard so the smoke's click
  // can't quit the app.
  ipcMain.handle(UpdateChannels.restart, () => {
    if (!app.isPackaged || process.env.MOGGING_FAKE_UPDATE) return
    // (isSilent = true, isForceRunAfter = true): reinstall with no NSIS UI, then relaunch us.
    // The pair matters — with isSilent = false electron-updater IGNORES isForceRunAfter and
    // substitutes autoRunAppAfterInstall, so it is the silent flag that makes "come back
    // afterwards" mean anything at all.
    //
    // Nothing is lost across the swap: terminal sessions live in the detached daemon
    // (ADR 0006), which outlives the app and hands the panes back on relaunch.
    autoUpdater.quitAndInstall(true, true)
  })

  // The rail row's retry after a failed check. Idempotent — the updater coalesces a check
  // that is already in flight.
  ipcMain.handle(UpdateChannels.check, () => {
    if (!app.isPackaged || process.env.MOGGING_FAKE_UPDATE) return
    void autoUpdater.checkForUpdates()
  })

  // Dev/smoke driver: replay the whole lifecycle to the renderer, no network.
  const fake = process.env.MOGGING_FAKE_UPDATE
  if (fake) {
    // Wait for the window's first paint so the renderer's listener is attached.
    const run = (): void => {
      push({ phase: 'checking' })
      setTimeout(() => push({ phase: 'available', version: fake }), 500)
      // Deliberately unhurried so the downloading row stays observable across a
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

  autoUpdater.logger = createUpdaterLog()
  autoUpdater.autoDownload = true // fetch in the background; the user is never asked to wait
  autoUpdater.autoInstallOnAppQuit = true // declining costs nothing — it lands on the next quit
  autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) => push({ phase: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => push({ phase: 'idle' }))
  autoUpdater.on('download-progress', (p) =>
    push({ phase: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => push({ phase: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    // Human reason to the UI (never a stack); telemetry gets the boolean; the log gets the url.
    push({ phase: 'error', error: 'update check failed' })
    getTelemetry().captureError(err, { feature: 'updater', op: 'check', platform: process.platform })
  })

  // checkForUpdates, NOT checkForUpdatesAndNotify: the latter fires a native OS notification
  // we cannot time, word, or hang "Restart now / Later" off — and it would now say the same
  // thing as the rail row, twice, in someone else's voice.
  void autoUpdater.checkForUpdates()
  // Re-check periodically for long-running sessions.
  setInterval(() => void autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000)
}
