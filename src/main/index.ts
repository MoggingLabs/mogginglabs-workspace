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

// App-wiring layer: compose the backend over an Electron context and open the
// window. All real logic lives in @backend and @ui; this file only connects them.
//
// PHASE 0: the backend (and its PTYs) run in this main process — already separate
// from the renderer, so a UI crash can't kill an agent. Phase 1 moves the backend
// into a dedicated persistent pty-host utilityProcess (see docs/adr/0003 and
// src/pty-host/).

let win: BrowserWindow | null = null
let disposeBackend: (() => void) | null = null

function openWindow(): void {
  win = createMainWindow()
  win.on('closed', () => {
    win = null
  })
}

app.whenReady().then(() => {
  initMainTelemetry() // observability first, so early errors are captured
  const ctx = createElectronContext(() => win?.webContents ?? null)
  disposeBackend = startBackend(ctx)
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
