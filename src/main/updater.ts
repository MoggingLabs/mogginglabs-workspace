import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UpdateChannels, UPDATE_PREFS_DEFAULT, type UpdatePrefs, type UpdateState } from '@contracts'
import { getTelemetry } from '@backend'
import { getSettingsStore } from './app-settings'
import { updateDriver } from './fixture-port'

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

// The last state pushed, so a late subscriber (the settings pane, mounted long after boot)
// can be told where things stand instead of showing a blank row until the next 6-hour tick.
let last: UpdateState = { phase: 'idle' }

function push(patch: UpdateState): void {
  // lastCheckedAt/currentVersion/supported are sticky: a `downloading` push must not erase
  // the timestamp the preceding `checking` earned.
  last = { ...last, ...patch }
  getWin?.()?.webContents.send(UpdateChannels.state, last)
}

const PREFS_KEY = 'update.prefs'

function readPrefs(): UpdatePrefs {
  try {
    const raw = getSettingsStore()?.getSetting(PREFS_KEY)
    if (!raw) return UPDATE_PREFS_DEFAULT
    // Merge over the defaults: a prefs blob written by an older build is missing whatever
    // key we added since, and `undefined` must never read as "off".
    return { ...UPDATE_PREFS_DEFAULT, ...(JSON.parse(raw) as Partial<UpdatePrefs>) }
  } catch {
    return UPDATE_PREFS_DEFAULT
  }
}

/**
 * Prefs are applied to the live updater, not just stored. allowPrerelease also flips
 * allowDowngrade inside electron-updater, which is what lets someone who turns pre-releases
 * back OFF fall from v1.0.0-beta.2 down to stable v0.9.9 — without it they would be stranded
 * on a beta forever, which is a worse trap than the setting solves.
 */
function applyPrefs(p: UpdatePrefs): void {
  autoUpdater.allowPrerelease = p.allowPrerelease
  autoUpdater.allowDowngrade = p.allowPrerelease
  autoUpdater.autoInstallOnAppQuit = p.installOnQuit
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

  const fake = process.env.MOGGING_FAKE_UPDATE
  // The FAILING feed (the UPDATEFAIL gate) is INSTALLED by the dev entry, not read from the
  // environment. It used to be `process.env.MOGGING_UPDATEFAIL`, right here, in a module that
  // ships — so a signed install carried an environment variable that could make its own updater
  // report a dead feed (audit finding 41). Null in production, always: src/main/fixture-port.ts.
  //
  // MOGGING_FAKE_UPDATE above STAYS. It is not harness — it is the documented safety valve that
  // drives the real renderer flow with no network, and the artifact gate allows it by name.
  const driveFailure = updateDriver()
  const feedLive = app.isPackaged && !fake && !driveFailure
  last = {
    phase: 'idle',
    currentVersion: app.getVersion(),
    supported: feedLive || !!fake || !!driveFailure
  }

  ipcMain.handle(UpdateChannels.stateGet, (): UpdateState => last)
  ipcMain.handle(UpdateChannels.prefsGet, (): UpdatePrefs => readPrefs())
  ipcMain.handle(UpdateChannels.prefsSet, (_e, prefs: UpdatePrefs) => {
    const next: UpdatePrefs = { ...UPDATE_PREFS_DEFAULT, ...prefs }
    getSettingsStore()?.setSetting(PREFS_KEY, JSON.stringify(next))
    if (!feedLive) return
    applyPrefs(next)
    // Switching channel changes what "latest" means, so re-ask immediately rather than
    // leaving the user staring at a stale answer until the next six-hour tick.
    void autoUpdater.checkForUpdates()
  })

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
    if (driveFailure) {
      driveFailure(push)
      return
    }
    if (!app.isPackaged || fake) return
    void autoUpdater.checkForUpdates()
  })

  // Dev/smoke driver: replay the whole lifecycle to the renderer, no network.
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

  if (driveFailure) {
    const win = winGetter()
    const run = (): void => driveFailure(push)
    if (win && !win.webContents.isLoading()) setTimeout(run, 1500)
    else win?.webContents.once('did-finish-load', () => setTimeout(run, 1500))
    return
  }

  if (!app.isPackaged) return

  autoUpdater.logger = createUpdaterLog()
  autoUpdater.autoDownload = true // fetch in the background; the user is never asked to wait
  applyPrefs(readPrefs()) // sets autoInstallOnAppQuit + the pre-release channel

  autoUpdater.on('checking-for-update', () => push({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    push({ phase: 'available', version: info.version, lastCheckedAt: Date.now() })
  )
  autoUpdater.on('update-not-available', () => push({ phase: 'idle', lastCheckedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) =>
    push({ phase: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => push({ phase: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    // Human reason to the UI (never a stack); telemetry gets the boolean; the log gets the url.
    // A failed check still COUNTS as a check — the timestamp is what makes a dead feed visible.
    push({ phase: 'error', error: 'update check failed', lastCheckedAt: Date.now() })
    getTelemetry().captureError(err, { feature: 'updater', op: 'check', platform: process.platform })
  })

  // checkForUpdates, NOT checkForUpdatesAndNotify: the latter fires a native OS notification
  // we cannot time, word, or hang "Restart now / Later" off — and it would now say the same
  // thing as the rail row, twice, in someone else's voice.
  void autoUpdater.checkForUpdates()
  // Re-check periodically for long-running sessions.
  setInterval(() => void autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000)
}
