import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  UpdateChannels,
  UPDATE_PREFS_DEFAULT,
  type UpdateCheckRequest,
  type UpdatePrefs,
  type UpdateState
} from '@contracts'
import { getTelemetry } from '@backend'
import { isNetworkDownMessage } from '@backend/core/net/reachability'
import { getSettingsStore } from './app-settings'
import { retireOwnDaemon, endDaemonQuiescence } from './daemon-client'
import { updateFeedFixture } from './fixture-port'

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

// electron-updater rejects the checkForUpdates() promise ON TOP OF emitting `error`, so a
// failed check arrives TWICE: once to the `error` listener (which reports the telemetry
// boolean, logs the url, and degrades the rail to "update check failed"), and once as a
// promise rejection. A missing or unreadable `resources/app-update.yml` — a dir-only build,
// an AV-quarantined file, a corrupted install — throws ENOENT synchronously inside that
// promise, before any network. Left on a bare `void`, the rejection reaches fatal.ts's
// unhandledRejection hook, which treats it as a boot failure and kills the whole app: the
// "MoggingLabs Workspace failed to start" dialog, over nothing worse than a feed it could
// not read. The `error` event already carries every consequence worth having; the rejection
// is a pure duplicate. Absorb it at every call site — a failed update CHECK must never
// become a failed BOOT. (Main grew the identical fix in parallel; one copy survives.)
function checkForUpdatesSafely(): void {
  void autoUpdater.checkForUpdates().catch(() => {
    /* already surfaced by the `error` listener above; a rejection here adds nothing */
  })
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

// ── OFFLINE ≠ BROKEN ──────────────────────────────────────────────────────────────────────
// The error listener used to treat every failure alike, so one wake-from-sleep DNS blip
// (net::ERR_NAME_NOT_RESOLVED while the Wi-Fi re-associated — found live on v0.14.0,
// updater.log) latched the rail's red "Update failed — retry" and left it there for the full
// six-hour tick: an alarm over nothing the user can fix, with a retry that "did nothing"
// because the network was still down when they clicked it. These tokens are the net layer's
// vocabulary for "this MACHINE cannot reach anything right now" — Chromium's net::ERR_* from
// Electron's request stack, Node's errno codes from the differential downloader. A message
// wearing one is a fact about connectivity, not about the feed, so a BACKGROUND check that
// fails this way stays quiet (idle + the `offline` flag; the retry ladder below and the
// renderer's online-event poke self-heal it). Only a HUMAN-initiated check answers with the
// error row. Anything else — a 404 on latest.yml, a signature refusal, a yml parse error —
// means the feed was REACHED and is broken, and that stays loud on every check: a feed whose
// downloads 404'd went unnoticed for nine releases precisely because nothing surfaced it.
// The token list itself lives in backend/core/net/reachability.ts now (phase-tools/03): the
// connection status engine obeys the same law, and one classifier keeps them agreeing.
const isOfflineError = isNetworkDownMessage

// Human reasons for the two failure kinds (the rail tooltip and the settings card; never a
// stack). Lowercase and unterminated so settings can compose "The last check failed — …".
const OFFLINE_REASON = 'could not reach the update server — check your connection and try again'
const FEED_REASON = 'the update feed could not be read'

// Self-heal cadence after an offline failure: a minute, five, then every fifteen until the
// network comes back — so a latched answer never outlives the outage by more than a tick.
const OFFLINE_RETRY_LADDER = [60_000, 300_000, 900_000]

export function initAutoUpdate(winGetter: () => BrowserWindow | null): void {
  getWin = winGetter

  const fake = process.env.MOGGING_FAKE_UPDATE
  // The FIXTURE feed (the UPDATEFAIL/UPDATEOFFLINE gates) is INSTALLED by the dev entry, not
  // read from the environment. It used to be `process.env.MOGGING_UPDATEFAIL`, right here, in
  // a module that ships — so a signed install carried an environment variable that could make
  // its own updater report a dead feed (audit finding 41). Null in production, always:
  // src/main/fixture-port.ts. Unlike the old driver it does NOT fabricate renderer states; it
  // only answers "how did this one check attempt end", and the classification and retry
  // machinery below runs over its answers — so the gates bite on production logic.
  //
  // MOGGING_FAKE_UPDATE above STAYS. It is not harness — it is the documented safety valve that
  // drives the real renderer flow with no network, and the artifact gate allows it by name.
  const fixture = updateFeedFixture()
  const feedLive = app.isPackaged && !fake && !fixture
  last = {
    phase: 'idle',
    currentVersion: app.getVersion(),
    supported: feedLive || !!fake || !!fixture
  }

  // ── ONE CHECK, TWO WORLDS ─────────────────────────────────────────────────────────────
  // `manualCheck` is whether a HUMAN asked for the in-flight check — the rail row's retry,
  // the settings button, a prefs flip. The boot check, the six-hour tick, the offline-retry
  // ladder and the renderer's online-recovery poke are all machine-initiated. One flag, not
  // an argument threaded through electron-updater's events: the updater coalesces
  // overlapping checks into one completion, and if ANY of the coalesced askers was the
  // user, the answer is owed to them.
  let manualCheck = false
  let offlineRetryIx = 0
  let offlineRetryTimer: NodeJS.Timeout | null = null

  const clearOfflineRetry = (): void => {
    offlineRetryIx = 0
    if (offlineRetryTimer) clearTimeout(offlineRetryTimer)
    offlineRetryTimer = null
  }

  const scheduleOfflineRetry = (): void => {
    const ladder = fixture?.retryDelaysMs ?? OFFLINE_RETRY_LADDER
    const delay = ladder[Math.min(offlineRetryIx, ladder.length - 1)]
    offlineRetryIx += 1
    if (offlineRetryTimer) clearTimeout(offlineRetryTimer)
    offlineRetryTimer = setTimeout(() => {
      offlineRetryTimer = null
      startCheck(false)
    }, delay)
  }

  // Every road out of a completed check funnels through these two — real feed and fixture
  // alike, so the classification the gates bite on is the code production runs.
  const settleNothingNewer = (): void => {
    manualCheck = false
    clearOfflineRetry()
    push({ phase: 'idle', offline: false, error: undefined, lastCheckedAt: Date.now() })
  }

  const settleFailure = (message: string): void => {
    const manual = manualCheck
    manualCheck = false
    const offline = isOfflineError(message)
    // A broken feed gains nothing from a minutes-scale ladder — the six-hour tick is enough.
    if (offline) scheduleOfflineRetry()
    else clearOfflineRetry()
    if (offline && !manual && last.phase !== 'error') {
      // Nobody asked, and nothing is wrong with the updater — the machine is just offline.
      // Quiet idle, flagged so the settings card can say so honestly; the ladder and the
      // renderer's online poke re-check without anyone clicking anything. A failed check
      // still COUNTS as a check — the timestamp is what makes a dead feed visible.
      push({ phase: 'idle', offline: true, error: undefined, lastCheckedAt: Date.now() })
    } else {
      // Loud: a human asked, or the feed itself is broken. And once a human was TOLD
      // "failed", a later background failure refreshes the row rather than retracting it —
      // an answer that quietly vanishes while the condition persists is worse than none.
      // Only an attempt that actually succeeds clears it.
      push({
        phase: 'error',
        offline,
        error: offline ? OFFLINE_REASON : FEED_REASON,
        lastCheckedAt: Date.now()
      })
    }
  }

  // Fixture pacing mirrors the real updater's coalescing: one attempt in flight, and a
  // human joining mid-attempt makes that attempt theirs.
  let fixtureCheckInFlight = false
  const startCheck = (manual: boolean): void => {
    manualCheck = manualCheck || manual
    if (!fixture) {
      checkForUpdatesSafely()
      return
    }
    if (fixtureCheckInFlight) return
    fixtureCheckInFlight = true
    push({ phase: 'checking', error: undefined })
    // Unhurried enough that a gate can observe the 'checking' hop.
    setTimeout(() => {
      fixtureCheckInFlight = false
      const outcome = fixture.next()
      if (outcome.kind === 'ok') settleNothingNewer()
      else settleFailure(outcome.message)
    }, 250)
  }

  ipcMain.handle(UpdateChannels.stateGet, (): UpdateState => last)
  ipcMain.handle(UpdateChannels.prefsGet, (): UpdatePrefs => readPrefs())
  ipcMain.handle(UpdateChannels.prefsSet, (_e, prefs: UpdatePrefs) => {
    const next: UpdatePrefs = { ...UPDATE_PREFS_DEFAULT, ...prefs }
    getSettingsStore()?.setSetting(PREFS_KEY, JSON.stringify(next))
    if (!feedLive) return
    applyPrefs(next)
    // Switching channel changes what "latest" means, so re-ask immediately rather than
    // leaving the user staring at a stale answer until the next six-hour tick. Manual: the
    // user is standing in settings looking at the row, so a failure reports back.
    startCheck(true)
  })

  // ── THE PRE-INSTALL RETIRE ────────────────────────────────────────────────────────────
  // The daemon is spawned from a binary INSIDE THE INSTALL DIR (daemon-client: the bundled
  // standalone helper, resources/node-helper — ADR 0017) and outlives the app by design
  // (ADR 0006). A running process holds
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

  // The rail row's retry after a failed check, the settings button, the palette verb — and,
  // with `auto: true`, the renderer's online-recovery poke, which must classify like the
  // clock's checks: a network that flaps back down mid-check must not pop the error row
  // with nobody at the wheel. Idempotent — overlapping checks coalesce.
  ipcMain.handle(UpdateChannels.check, (_e, req?: UpdateCheckRequest) => {
    if (!fixture && (!app.isPackaged || fake)) return
    startCheck(!req?.auto)
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

  if (fixture) {
    // The BOOT check, driven — background, exactly like production's. The gates choreograph
    // everything else through the real check/retry machinery above.
    const win = winGetter()
    const run = (): void => startCheck(false)
    if (win && !win.webContents.isLoading()) setTimeout(run, 1500)
    else win?.webContents.once('did-finish-load', () => setTimeout(run, 1500))
    return
  }

  if (!app.isPackaged) return

  autoUpdater.logger = createUpdaterLog()
  autoUpdater.autoDownload = true // fetch in the background; the user is never asked to wait
  applyPrefs(readPrefs()) // sets autoInstallOnAppQuit + the pre-release channel

  autoUpdater.on('checking-for-update', () => push({ phase: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => {
    manualCheck = false
    clearOfflineRetry()
    push({ phase: 'available', version: info.version, offline: false, lastCheckedAt: Date.now() })
  })
  autoUpdater.on('update-not-available', () => settleNothingNewer())
  autoUpdater.on('download-progress', (p) =>
    push({ phase: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => push({ phase: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    // settleFailure decides what the UI hears (offline vs broken feed, quiet vs loud);
    // telemetry gets booleans; the log already has the url.
    const message = err instanceof Error ? err.message : String(err)
    getTelemetry().captureError(err, {
      feature: 'updater',
      op: 'check',
      platform: process.platform,
      offline: isOfflineError(message)
    })
    settleFailure(message)
  })

  // checkForUpdates, NOT checkForUpdatesAndNotify: the latter fires a native OS notification
  // we cannot time, word, or hang "Restart now / Later" off — and it would now say the same
  // thing as the rail row, twice, in someone else's voice.
  startCheck(false)
  // Re-check periodically for long-running sessions.
  setInterval(() => startCheck(false), 6 * 60 * 60 * 1000)
}
