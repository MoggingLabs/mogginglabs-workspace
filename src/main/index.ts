import { app, BrowserWindow } from 'electron'
import { getTelemetry, startBackend } from '@backend'
import { createMainWindow } from './window'
import { createElectronContext } from './electron-context'
import { initMainTelemetry } from './telemetry'
import { registerClipboard } from './clipboard'
import { registerAppSettings, disposeAppSettings } from './app-settings'
import { registerAgents } from './agents'
import { runSmoke } from './smoke'
import { runAgentSmoke } from './agent-smoke'
import { runStateSmoke } from './state-smoke'
import { runReloadSmoke } from './reload-smoke'
import { runShot } from './shot'
import { runMultipaneSmoke } from './multipane-smoke'
import { runWorkspaceSmoke } from './workspace-smoke'
import { runAgentLaunchSmoke } from './agentlaunch-smoke'
import { startDaemonBackend } from './daemon-relay'
import { runDaemonSurviveSmoke } from './daemon-survive-smoke'
import { registerDeepLink, initialDeepLinkCwd } from './deep-link'
import { WorkspaceChannels } from '@contracts'

// App-wiring layer: compose the backend over an Electron context and open the
// window. All real logic lives in @backend and @ui; this file only connects them.
//
// PHASE 0: the backend (and its PTYs) ran in this main process. PHASE 1: the PTYs now live
// in a detached daemon (the DEFAULT) that survives a renderer reload AND a main crash / app
// restart, with full terminal + scrollback + agent-state parity (see docs/adr/0006 and
// src/pty-daemon/). MOGGING_INPROC forces the in-proc backend; daemon startup is also wrapped
// so any failure falls back to in-proc, keeping the app functional.

let win: BrowserWindow | null = null
let disposeBackend: (() => void) | null = null

// Single-instance + mogging:// deep link so `mogging .` focuses a running app. Skipped under
// smokes (some launch a second instance); normal dev/production runs hold the lock.
const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))
const primaryInstance = isSmoke || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

function openWindow(): void {
  win = createMainWindow()
  win.on('closed', () => {
    win = null
  })
}

app.whenReady().then(async () => {
  if (!primaryInstance) return // a second instance; the primary handles the deep link + quits us

  // Env-gated app-level survival smoke: two separate launches (A then B) prove an agent
  // in the detached daemon outlives an app quit/relaunch (ADR 0006).
  if (process.env.MOGGING_SURVIVE) {
    await runDaemonSurviveSmoke(process.env.MOGGING_SURVIVE)
    return
  }

  initMainTelemetry() // observability first, so early errors are captured

  // The detached PTY daemon (ADR 0006) is now the DEFAULT — full parity with in-proc plus
  // survival across a main crash / app restart. MOGGING_INPROC forces the in-proc backend.
  const startInProc = (): void => {
    const ctx = createElectronContext(() => win?.webContents ?? null)
    disposeBackend = startBackend(ctx)
  }
  if (process.env.MOGGING_INPROC) {
    startInProc()
  } else {
    try {
      disposeBackend = await startDaemonBackend(() => win?.webContents ?? null)
    } catch (err) {
      getTelemetry().captureError(err, { feature: 'daemon', op: 'start', platform: process.platform })
      startInProc() // daemon unavailable -> in-proc so the app still works
    }
  }
  registerClipboard() // system clipboard IPC (app-layer, Electron-only)
  registerAppSettings() // app-level workspace state (tabs + theme) persistence (Phase-1/05)
  registerAgents() // agent launcher: detect installed CLIs + build launch commands (Phase-1/06)

  openWindow()

  if (!isSmoke) {
    registerDeepLink(() => win) // mogging:// -> open/focus a workspace for a directory
    const initialCwd = initialDeepLinkCwd()
    if (initialCwd && win) {
      const w = win
      const send = (): void => w.webContents.send(WorkspaceChannels.openCwd, initialCwd)
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
      else send()
    }
  }

  if (process.env.MOGGING_AGENT && win) {
    runAgentSmoke(win, process.env.MOGGING_AGENT) // env-gated agent-CLI TUI smoke
  } else if (process.env.MOGGING_STATE && win) {
    runStateSmoke(win) // env-gated OSC agent-state smoke
  } else if (process.env.MOGGING_RELOAD && win) {
    runReloadSmoke(win) // env-gated renderer-reload survival smoke
  } else if (process.env.MOGGING_SMOKE && win) {
    runSmoke(win) // env-gated runtime smoke test
  } else if (process.env.MOGGING_SHOT && win) {
    runShot(win) // env-gated visual smoke: capture the window to out/shot.png
  } else if (process.env.MOGGING_MULTIPANE && win) {
    runMultipaneSmoke(win) // env-gated multi-pane isolation smoke
  } else if (process.env.MOGGING_WORKSPACE && win) {
    runWorkspaceSmoke(win, process.env.MOGGING_WORKSPACE) // env-gated workspace persist/restore smoke
  } else if (process.env.MOGGING_AGENTLAUNCH && win) {
    runAgentLaunchSmoke(win) // env-gated agent-launcher smoke (picker -> TUI)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  disposeAppSettings()
  disposeBackend?.()
  disposeBackend = null
  void getTelemetry().flush(2000)
})
