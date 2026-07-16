import * as os from 'node:os'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { getTelemetry, startBackend } from '@backend'
import { createMainWindow } from './window'
import { createElectronContext } from './electron-context'
import { initMainTelemetry, flushTelemetry } from './telemetry'
import { registerClipboard } from './clipboard'
import { registerAppMenu } from './menu'
import { registerDialogs } from './dialogs'
import { registerShellChrome, wireWindowState } from './shell-chrome'
import { registerAppSettings, disposeAppSettings } from './app-settings'
import { registerAgents, disposeAgentInstalls } from './agents'
import { registerAgentSettings, disposeAgentSettings } from './agent-settings'
import { registerBrowserDock } from './browser-dock'
import { startMcpEndpoint, stopMcpEndpoint } from './mcp-endpoint'
import { registerTemplates } from './templates'
import { registerAttention } from './attention'
import { registerGit } from './git'
import { registerContext } from './context'
import { registerWorktrees } from './worktrees'
import { registerFsBrowse } from './fs-browse'
import { registerExplorer } from './explorer'
import { registerReview } from './review'
import { registerBoard } from './board'
import { registerProfiles } from './profiles'
import { registerUsage } from './usage'
import { registerRemotes } from './remotes'
import { registerIntegrations } from './integrations'
import { registerEventBridge } from './event-bridge'
import { registerTrail } from './trail'
import { registerMcpManager } from './mcp-manager'
import { registerConnections } from './connections'
import { registerMcpStatus } from './mcp-status'
import { registerServices } from './services'
import { startDaemonBackend } from './daemon-relay'
import { DaemonMigrationDeferredError } from './daemon-migrate'
import { installCliRuntime } from './cli-runtime'
import { installDeepLinkListeners, registerDeepLink, initialDeepLinkCwd, initialControlCommand } from './deep-link'
import { ControlChannels, WorkspaceChannels } from '@contracts'
import { initAutoUpdate } from './updater'
import { fatal, installFatalHandlers } from './fatal'
import { scrubInheritedPaneEnv } from './pane-env'
import { runtimeIsolationError } from './runtime-isolation'
import { assertNativeModules } from './native-preflight'
import { assertPtyHostSupported } from '@backend/platform/pty-host'
import { registerRuntimeHealth, setDaemonHealth, setDaemonHealthRetry } from './runtime-health'

// THE app-wiring layer: compose the backend over an Electron context and open the window. All
// real logic lives in @backend and @ui; this file only connects them.
//
// It exists as its OWN module because there are TWO entries and only ONE boot sequence (audit
// finding 41). src/main/index.ts is production; src/main/index.dev.ts is production PLUS the
// smoke/gallery harness, and electron.vite.config.ts picks between them by `command` — `build`
// takes index.ts, `serve` (npm run dev, which every gate runs) takes index.dev.ts. So the ~100
// harness modules, the SMOKE_ENV allowlist and the MOGGING_<GATE> dispatcher are simply not in
// the module graph of the shipped artifact; scripts/check-prod-artifact.mjs enforces that.
//
// The sequence below is therefore the ONLY copy. The dev entry does not re-sequence it — it
// passes BootHooks and gets called back at the two points the harness needs (see BootHooks).
// Duplicating the sequence in the dev entry would let the two drift, and the drift would be
// invisible: every gate would still pass while testing a boot order production does not run.
//
// PHASE 0: the backend (and its PTYs) ran in this main process. PHASE 1: the PTYs now live
// in a detached daemon (the DEFAULT) that survives a renderer reload AND a main crash / app
// restart, with full terminal + scrollback + agent-state parity (see docs/adr/0006 and
// src/pty-daemon/). MOGGING_INPROC forces the in-proc backend; daemon startup is also wrapped
// so any failure falls back to in-proc, keeping the app functional.

/**
 * The two seams the harness needs, and nothing else. Each windowless hook returns TRUE to mean
 * "I handled this launch — stop booting" (the smokes that run here deliberately never reach a
 * window, and several must run BEFORE the store/daemon they are testing exists).
 *
 * Production passes no hooks: `bootMain()`.
 */
export interface BootHooks {
  /**
   * After the native/PTY preflight, BEFORE registerAppSettings() and the daemon.
   * The gates that must precede this version's settings store / sessions.db (MIGRATE's whole
   * entry condition is that the DB does not exist yet).
   */
  beforeAppSettings?: () => Promise<boolean>
  /**
   * After registerAppSettings() + registerRuntimeHealth(), before telemetry and the backend.
   * The windowless gates that read the SAME persisted opt-in/plan production reads, but want
   * no daemon and no window.
   */
  afterAppSettings?: () => Promise<boolean>
  /** After openWindow() and the deep-link/auto-update wiring: every windowed gate. */
  afterWindow?: (win: BrowserWindow) => void
}

export interface BootOptions {
  /**
   * TRUE only when the DEV entry saw a MOGGING_<GATE> var (its `isSmoke`). It skips the
   * single-instance lock (some gates launch a second instance), the OS-global mogging://
   * registration, and the real update feed — see index.dev.ts for the full account of why
   * that is an ALLOWLIST and not a denylist.
   *
   * Production cannot set it: src/main/index.ts calls `bootMain()` with no arguments, so the
   * branches below are statically dead in the shipped bundle.
   */
  harness?: boolean
  hooks?: BootHooks
}

let win: BrowserWindow | null = null
let harnessActive = false // gates get a window Cocoa won't clamp (see createMainWindow)
let disposeBackend: (() => void) | null = null
let disposeGit: (() => void) | null = null
let disposeContext: (() => void) | null = null

/**
 * Runtime knobs that must be settled BEFORE anything derives a path from them — call this at
 * the top of the entry's module body, exactly where it used to live. It is a function and not
 * module-scope side effects on purpose: an entry that imports ~100 harness modules runs ALL of
 * their top-level code before its own body, and the userData path must not depend on which
 * entry (and therefore which import list) is booting.
 */
export function prepareRuntime(): void {
  // Test-support: smokes isolate their persisted state by pointing MOGGING_USERDATA at a
  // temp dir. Electron resolves userData through the OS known-folders API, so overriding
  // the APPDATA env var alone does NOT isolate it — this explicit hook does.
  if (process.env.MOGGING_USERDATA) app.setPath('userData', process.env.MOGGING_USERDATA)
  // Dev must not share state with the installed app. The packaged package.json carries the SAME
  // `name` (and no productName), so both resolve %APPDATA%/mogginglabs-workspace: one Chromium
  // profile (the "Unable to move the cache: Access is denied" spam when both run), one
  // app-settings.db under two writers (each app's exit clobbers the other's workspace state), and
  // one single-instance lock (Electron keys it on userData). `-dev` splits all three at once.
  else if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')

  // The RUNTIME side of the same split (contracts/daemon/protocol.ts, ReleaseChannel): daemon dir,
  // control endpoint, and deep-link scheme all key off MOGGING_CHANNEL. Set it here — before any
  // module derives a path — and it propagates by inheritance: daemon at spawn, panes from the
  // daemon, CLIs from the pane env. Packaged apps CLEAR it (an installed app launched from inside a
  // dev pane would otherwise inherit 'dev' and squat the dev channel): derived, never trusted up.
  // Smokes stay prod-shaped — they already isolate the whole runtime tree via LOCALAPPDATA.
  //
  // "Already isolate" is enforced, not hoped: an UNPACKAGED launch that sets MOGGING_USERDATA
  // without redirecting the runtime base is a prod-shaped app of a foreign build aimed at the
  // REAL run/v<N> dir — its build-stamp check then retires the installed app's live daemon
  // (every pane's process dies) and starts a retire war on reconnect. Refuse to boot instead
  // (runtime-isolation.ts); the properly-launched harness (scripts/qa-smokes.sh) is unaffected.
  if (!app.isPackaged) {
    const isolation = runtimeIsolationError(process.env, process.platform, os.homedir())
    if (isolation) {
      console.error(`[boot] ${isolation}`)
      process.exit(1)
    }
  }
  if (app.isPackaged || process.env.MOGGING_USERDATA) delete process.env.MOGGING_CHANNEL
  else process.env.MOGGING_CHANNEL = 'dev'

  // The SAME rule, for the same reason, applied to the pane identity the daemon injects: an app
  // launched from inside a MoggingLabs pane inherits WHICH pane it came from and WHERE that
  // pane's daemon is, then hands both to every child it spawns. `mogging` prefers the inherited
  // endpoint over the runtime dir (inside a real pane that is the right answer), so the app's own
  // CLI children — every gate's `mogging` call — talked to the HOST's daemon instead of ours, and
  // a colliding pane id would have let them mutate the user's live session. Not a pane; do not
  // wear a pane's name. (pane-env.ts has the full account; the daemon re-injects the true values
  // into each pane it spawns, which is the only place they mean anything.)
  const inheritedPaneEnv = scrubInheritedPaneEnv(process.env)
  if (inheritedPaneEnv.length) {
    console.warn(`[env] launched from inside a pane — dropped inherited ${inheritedPaneEnv.join(', ')}`)
  }

  // CI ONLY (Linux headless): force the libsecret safeStorage backend so the vault
  // gates run against a REAL keychain (the CI job stands up an unlocked
  // gnome-keyring on the session bus). Production auto-detects the desktop's own
  // backend — this switch is set only when MOGGING_CI_KEYRING is exported, never
  // in a real install. Must run before app is ready (before any safeStorage use).
  if (process.env.MOGGING_CI_KEYRING && process.platform === 'linux') {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
  }
}

function openWindow(): void {
  const w = createMainWindow({ largerThanScreen: harnessActive })
  win = w
  wireWindowState(w) // fullscreen/maximize -> renderer chrome classes (5/04)
  // Only the CURRENT window may clear the pointer: a window re-created for a deep link
  // (ensureWindow) must not be nulled by its predecessor's late 'closed'.
  w.on('closed', () => {
    if (win === w) win = null
  })
}

/** The window, recreated if it is gone (macOS keeps the app alive without one). */
function ensureWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) openWindow()
  return win as BrowserWindow
}

/** The renderer target for every backend/daemon event. `win` is nulled on 'closed', but the
 *  webContents dies BEFORE that event: a daemon socket event landing in the gap threw inside
 *  send(), and the uncaughtException handler turns that into app.exit(1) — closing a window
 *  while agents streamed output hard-exited the app. */
function liveWebContents(): WebContents | null {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return null
  return win.webContents
}

/**
 * Take the lock, wire the lifecycle, and boot. Call it synchronously from the entry's module
 * body (the single-instance lock and the fatal handlers must both be in place before
 * `app.whenReady()` resolves).
 */
export function bootMain({ harness = false, hooks }: BootOptions = {}): void {
  harnessActive = harness
  // Single-instance + mogging:// deep link so `mogging .` focuses a running app. Skipped under
  // the harness (some gates launch a second instance); normal dev/production runs hold the lock.
  // Dev needs no bypass: it holds its OWN lock via the -dev userData (Electron keys the lock on
  // userData), so a dev build runs alongside the installed release.
  const primaryInstance = harness || app.requestSingleInstanceLock()
  if (!primaryInstance) app.quit()
  // The lock is held from HERE, but registerDeepLink is ~25 s of boot away (daemon migrate +
  // start + feature registration). A `mogging .` fired into that gap reached an app with no
  // 'second-instance' listener: the second instance exited 0 and the command vanished. Listen
  // now — deliveries queue until the window exists.
  else if (!harness) installDeepLinkListeners()

  installFatalHandlers(harness) // before whenReady: early wiring must not fail silently

  app
    .whenReady()
    .then(async () => {
      if (!primaryInstance) return // a second instance; the primary handles the deep link + quits us

      // A desktop install does not get npm's package-bin links. Copy the CLI/MCP satellites into
      // the persistent private runtime, generate `mogging`, and seed PATH before either PTY backend
      // starts so every local pane and agent gets the protocol without provider-specific setup.
      try {
        installCliRuntime()
      } catch (err) {
        fatal(err, 'cli-runtime')
        return
      }

      assertNativeModules() // stale/missing .node -> exit 1 with the rebuild command, never a broken window
      // Windows < 18309 would silently get a winpty, whose resize semantics the UI does not model.
      // Refuse at boot rather than smear a live agent frame ten minutes in.
      try {
        assertPtyHostSupported()
      } catch (err) {
        fatal(err, 'pty-host')
        return
      }

      // ── HOOK: windowless, pre-store. See BootHooks.beforeAppSettings.
      if (await hooks?.beforeAppSettings?.()) return

      registerAppSettings() // app-level state store first — telemetry reads persisted consent from it
      registerRuntimeHealth(liveWebContents)

      // ── HOOK: windowless, post-store. See BootHooks.afterAppSettings.
      if (await hooks?.afterAppSettings?.()) return

      initMainTelemetry(() => win) // observability next, so early errors are captured (opt-in, ADR 0005)

      // The detached PTY daemon (ADR 0006) is now the DEFAULT — full parity with in-proc plus
      // survival across a main crash / app restart. MOGGING_INPROC forces the in-proc backend.
      const startInProc = (message: string): void => {
        const ctx = createElectronContext(liveWebContents)
        disposeBackend = startBackend(ctx)
        setDaemonHealthRetry(null)
        setDaemonHealth({ mode: 'in-process', state: 'degraded', message, sessionSurvival: false })
      }
      if (process.env.MOGGING_INPROC) {
        startInProc('Terminals are running in-process. They work normally, but cannot survive an app restart.')
      } else {
        try {
          disposeBackend = await startDaemonBackend(liveWebContents)
        } catch (err) {
          getTelemetry().captureError(err, { feature: 'daemon', op: 'start', platform: process.platform })
          // A real degradation (no pane survival across restarts). Telemetry is opt-in, so stderr is
          // the only channel that always exists — this fallback used to happen with nothing printed.
          const why = err instanceof Error ? err.message : String(err)
          console.warn(`[daemon] start failed, falling back to the in-proc backend: ${why}`)
          if (err instanceof DaemonMigrationDeferredError) {
            await dialog.showMessageBox({
              type: 'warning',
              title: 'Legacy remote sessions are still active',
              message: 'MoggingLabs left your older remote sessions running to avoid losing work.',
              detail:
                'This launch will use non-persistent local terminals. In Settings, confirm each legacy SSH host as POSIX, then restart MoggingLabs to complete the session upgrade.',
              buttons: ['Continue'],
              defaultId: 0
            })
          }
          startInProc(
            'The detached terminal service could not start. Current terminals work, but cannot survive an app restart.'
          )
        }
      }
      registerAppMenu() // explicit menu policy: mac keeps Edit roles, win/linux run menuless
      registerClipboard() // system clipboard IPC (app-layer, Electron-only)
      registerDialogs(() => win) // native directory picker for the new-workspace wizard
      registerShellChrome(() => win) // theme-tinted window-control overlay (organic chrome)
      registerBrowserDock(() => win, harness) // right browser dock: MAIN owns the WebContentsView (6/05)
      registerIntegrations(() => win) // per-workspace integrations grant: store + IPC + fan-out (8/03)
      registerEventBridge(() => win) // outbound event bridge: house events -> user webhooks (8/10)
      registerTrail() // the agent activity trail: local store + viewer IPC (8/05)
      registerMcpManager() // MCP manager: registry + per-CLI config writers (8/06)
      registerConnections(() => win) // the connection broker: the app IS the OAuth client (ADR 0014)
      registerMcpStatus(() => win) // MCP connection-status poller: pushed per-(server×cli) grid (8/11)
      registerServices(() => win) // service links: board card <-> GitHub PR/issue, live via gh (8/12)
      startMcpEndpoint() // agent-control transport: the MCP server reaches the dock + grant wire here (6/05b, 8/03)
      // The bundled catalog and IPC surface are installed synchronously before the
      // first await inside registerAgentSettings. Cache/version discovery and startup
      // reconciliation can continue behind first paint; each launch still reconciles
      // its exact target and fails closed.
      // `harness` is this entry's isSmoke: production always passes false.
      const agentSettingsStartup = registerAgentSettings(() => win, harness)
      registerAgents(() => win) // agent launcher: detect/install CLIs + build launch commands (Phase-1/06; Agent CLIs tab)
      registerTemplates() // provider-mix templates: presets + resolveLayout + custom template store (06b)
      registerAttention(() => win) // dock/taskbar badge when a background workspace needs attention (Phase-2/01)
      disposeGit = registerGit(liveWebContents) // read-only per-pane git branch + dirty (Phase-2/03)
      disposeContext = registerContext(liveWebContents) // per-pane agent context bar: tails the CLIs' own session logs (counts only)
      registerWorktrees() // worktree-per-agent isolation: add/list/remove only (Phase-3/03)
      registerFsBrowse() // read-only one-level directory listing for the folder browser (Phase-8.5/03)
      registerExplorer(() => win) // the explorer: read-only listing + the liveness law's watcher pool (Phase-11/01, /04)
      registerReview() // pre-ship diff review: redacted diff + guarded merge (Phase-3/04)
      registerBoard() // local Kanban board: cards that launch agents (Phase-3/05)
      registerProfiles() // provider profiles: pointer sets, deny-listed at save (Phase-4/04)
      registerRemotes() // remote (SSH) hosts: connection pointers only (Phase-4/05)
      registerUsage(() => win) // usage meters: adapters ride CLI-owned sessions (Phase-7/01, ADR 0007)

      openWindow()
      void agentSettingsStartup.catch((err) => {
        getTelemetry().captureError(err, { feature: 'agent-settings', op: 'startup' })
        console.warn('[agent-settings] startup initialization failed')
      })

      if (!harness) {
        registerDeepLink(ensureWindow) // mogging:// -> open/focus a workspace for a directory
        const initialCwd = initialDeepLinkCwd()
        if (initialCwd && win) {
          const w = win
          const send = (): void => w.webContents.send(WorkspaceChannels.openCwd, initialCwd)
          if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
          else send()
        }
        // Cold-start layout verb (mogging://control in argv, already validated).
        const initialControl = initialControlCommand()
        if (initialControl && win) {
          const w = win
          const send = (): void => {
            // Give restore a beat so `open` lands after existing workspaces re-attach.
            setTimeout(() => w.webContents.send(ControlChannels.command, initialControl), 800)
          }
          if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
          else send()
        }
        initAutoUpdate(() => win) // auto-update feed -> renderer update UX (packaged; MOGGING_FAKE_UPDATE drives dev/smoke)
      } else if (win) {
        // Gates too. The updater's FEED is what must stay out of them, and it already does —
        // `feedLive` is `app.isPackaged && !MOGGING_FAKE_UPDATE`, so an unpackaged gate run
        // touches no network whatever we do here. What initAutoUpdate ALSO does is register
        // update:stateGet / update:prefsGet, and the renderer's update UX calls both the moment
        // it mounts: skipping it left every gate with two unhandled-IPC console.errors, which is
        // an error the app would never survive in production and which any smoke that fails on
        // console errors (FLICKER, and the two scroll gates) reads as a real fault. It was one:
        // just not the one they were looking for.
        initAutoUpdate(() => win)
      }

      // ── HOOK: every windowed gate. See BootHooks.afterWindow.
      if (win) hooks?.afterWindow?.(win)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openWindow()
      })
    })
    // Boot is async. Unhandled, a throw here left the app running windowless with exit code 0.
    .catch((err) => fatal(err, 'boot'))

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void flushTelemetry() // best-effort vendor flush (no-op unless the user opted in)
    stopMcpEndpoint() // tear down the agent-control socket + endpoint file (6/05b)
    disposeAgentInstalls() // ephemeral install terminals must not outlive the app
    disposeAgentSettings()
    disposeAppSettings()
    disposeGit?.()
    disposeGit = null
    disposeContext?.()
    disposeContext = null
    disposeBackend?.()
    disposeBackend = null
    void getTelemetry().flush(2000)
  })
}
