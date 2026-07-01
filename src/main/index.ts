import { app, BrowserWindow } from 'electron'
import { getTelemetry, startBackend } from '@backend'
import { createMainWindow } from './window'
import { createElectronContext } from './electron-context'
import { initMainTelemetry } from './telemetry'
import { registerClipboard } from './clipboard'
import { runSmoke } from './smoke'
import { runAgentSmoke } from './agent-smoke'
import { runStateSmoke } from './state-smoke'
import { runReloadSmoke } from './reload-smoke'
import { runShot } from './shot'
import { runMultipaneSmoke } from './multipane-smoke'
import { startDaemonBackend } from './daemon-relay'
import { runDaemonSurviveSmoke } from './daemon-survive-smoke'

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

function openWindow(): void {
  win = createMainWindow()
  win.on('closed', () => {
    win = null
  })
}

app.whenReady().then(async () => {
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

  openWindow()
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
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  disposeBackend?.()
  disposeBackend = null
  void getTelemetry().flush(2000)
})
