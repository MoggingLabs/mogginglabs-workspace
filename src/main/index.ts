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
import { startDaemonBackend } from './daemon-relay'
import { runDaemonSurviveSmoke } from './daemon-survive-smoke'

// App-wiring layer: compose the backend over an Electron context and open the
// window. All real logic lives in @backend and @ui; this file only connects them.
//
// PHASE 0: the backend (and its PTYs) run in this main process — already separate
// from the renderer, so a UI crash can't kill an agent. PHASE 1 (opt-in, MOGGING_DAEMON)
// moves the PTYs into a detached daemon that ALSO survives a main crash / app restart
// (see docs/adr/0006 and src/pty-daemon/); the in-proc path remains the default until the
// daemon path reaches agent-state (OSC) parity.

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

  // MOGGING_DAEMON opts into the detached PTY daemon (ADR 0006); default stays in-proc
  // (backend-in-main), which is already renderer-reload-safe and keeps agent-state parity.
  if (process.env.MOGGING_DAEMON) {
    disposeBackend = await startDaemonBackend(() => win?.webContents ?? null)
  } else {
    const ctx = createElectronContext(() => win?.webContents ?? null)
    disposeBackend = startBackend(ctx)
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
