import { app, ipcMain, type BrowserWindow } from 'electron'
import { WorkspaceChannels } from '@contracts'

// App-wiring: raise a dock/taskbar attention badge when any BACKGROUND workspace needs the user
// (the renderer aggregates per-pane OSC state). macOS -> dock badge; Windows/Linux -> taskbar
// flash until focused. Carries a boolean only — never PTY content (ADR 0002/0005).
export function registerAttention(getWindow: () => BrowserWindow | null): void {
  ipcMain.on(WorkspaceChannels.attention, (_e, anyAttention: boolean) => {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(anyAttention ? '●' : '')
      return
    }
    getWindow()?.flashFrame(!!anyAttention)
  })
}
