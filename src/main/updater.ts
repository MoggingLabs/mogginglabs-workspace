import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { UpdateChannels, UPDATE_PREFS_DEFAULT, type UpdatePrefs, type UpdateState } from '@contracts'
import { getTelemetry } from '@backend'
import { getSettingsStore } from './app-settings'
import { retireOwnDaemon, endDaemonQuiescence } from './daemon-client'
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

/**
 * Every check goes through here, and the `.catch` is load-bearing: `checkForUpdates()`
 * REJECTS as well as emitting 'error' — a packaged build with no app-update.yml (any
 * dir-target build) rejects at boot, and an unabsorbed rejection lands in fatal.ts's
 * unhandledRejection handler, which is `app.exit(1)`: the app died on launch for a
 * missing FEED. The 'error' listener below already reports the failure (state push +
 * telemetry + updater.log), so the rejection itself carries no new information.
 */
function checkForUpdatesSafely(): void {
  autoUpdater.checkForUpdates().catch(() => undefined)
}

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
    checkForUpdatesSafely()
  })

  // ── THE PRE-INSTALL RETIRE ────────────────────────────────────────────────────────────
  // The daemon is spawned from the INSTALLED EXECUTABLE (daemon-client: process.execPath +
  // ELECTRON_RUN_AS_NODE) and outlives the app by design (ADR 0006). A running process holds
  // a Windows file lock on its own exe — so the very property that preserves your terminals
  // across an update is what made the installer fail: it closed the app, still saw a live
  // process on that exe (the daemon — windowless, unclosable), and stalled on "MoggingLabs
  // Workspace cannot be closed. Please close it manually and click Retry" (found live,
  // v0.11.0 → v0.11.1).
  //
  // So before ANY install runs, the app retires its own daemon — gracefully: the daemon's
  // shutdown persists the session store first (persistNow), and the post-update boot
  // cold-start restores every pane from it. Nothing is lost; it is restored rather than
  // carried. Quiescence stops the relay's reconnect loop from resurrecting the daemon (and
  // its exe lock) in the moments between the retire and process exit. Bounded and
  // best-effort: a daemon that will not die within the window must never trap the user in an
  // app that refuses to update — we proceed, and the installer's own daemon handling
  // (build/installer.nsh) is the second line.
  let retiredForInstall = false
  const retireForInstall = async (): Promise<void> => {
    if (retiredForInstall) return
    retiredForInstall = true
    try {
      const ok = await retireOwnDaemon({ quiesce: true })
      if (!ok) autoUpdater.logger?.warn?.('daemon did not retire before install; installer fallback will handle it')
    } catch (err) {
      getTelemetry().captureError(err, { feature: 'updater', op: 'retire-daemon', platform: process.platform })
    }
  }

  // "Restart now" from the ready toast / the rail's update row. In a fake-update run there
  // is nothing to install — the renderer just stops showing it; guard so the smoke's click
  // can't quit the app.
  ipcMain.handle(UpdateChannels.restart, async () => {
    if (!app.isPackaged || process.env.MOGGING_FAKE_UPDATE) return
    // Phase-gated in MAIN, not just in the renderer's button logic: this handler used to run
    // the retire + quiesce unconditionally, so any invocation with NO update actually pending
    // (a stale 'ready' row, a replayed IPC) retired the daemon, latched `quiescing` forever,
    // and quitAndInstall — with nothing to install — left the app running with every pane
    // dead behind a Retry button that could never succeed. The renderer is a hint; the state
    // machine is the authority.
    if (last.phase !== 'ready') return
    await retireForInstall() // release the exe lock BEFORE the installer needs the exe
    // (isSilent = true, isForceRunAfter = true): reinstall with no NSIS UI, then relaunch us.
    // The pair matters — with isSilent = false electron-updater IGNORES isForceRunAfter and
    // substitutes autoRunAppAfterInstall, so it is the silent flag that makes "come back
    // afterwards" mean anything at all.
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch (err) {
      // The installer never took over (no pending file, updater refusal). The app LIVES ON —
      // so quiescence must lift, or the reconnect loop spins on "quiescing" forever and every
      // terminal stays dead until an app restart. The relay is already retrying with backoff;
      // lifting the flag lets its next attempt respawn the daemon.
      autoUpdater.logger?.warn?.(
        `quitAndInstall did not hand off (${err instanceof Error ? err.message : String(err)}); lifting daemon quiescence`
      )
      getTelemetry().captureError(err, { feature: 'updater', op: 'quit-and-install', platform: process.platform })
      retiredForInstall = false
      endDaemonQuiescence()
    }
  })

  // The OTHER road to the installer: autoInstallOnAppQuit (applyPrefs above) runs it on a
  // plain window-close with an update pending — no restart click involved, same exe lock.
  // Intercept that one quit, retire, then resume quitting. Guarded three ways: only with a
  // downloaded update waiting, only when install-on-quit is actually on, and only once
  // (retiredForInstall) so the re-entrant app.quit() passes straight through. Every other
  // quit is untouched — the daemon SURVIVING a normal quit is the product's core promise.
  app.on('before-quit', (e) => {
    if (retiredForInstall || last.phase !== 'ready') return
    if (!app.isPackaged || !readPrefs().installOnQuit) return
    e.preventDefault()
    void retireForInstall().then(() => app.quit())
  })

  // The rail row's retry after a failed check. Idempotent — the updater coalesces a check
  // that is already in flight.
  ipcMain.handle(UpdateChannels.check, () => {
    if (driveFailure) {
      driveFailure(push)
      return
    }
    if (!app.isPackaged || fake) return
    checkForUpdatesSafely()
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
  checkForUpdatesSafely()
  // Re-check periodically for long-running sessions.
  setInterval(checkForUpdatesSafely, 6 * 60 * 60 * 1000)
}
