import { ipcMain, type BrowserWindow } from 'electron'
import { ShellChannels } from '@contracts'

// App-wiring: keep the native window-control overlay tinted to the active theme so the
// frameless header reads as one organic surface (Windows/Linux; macOS traffic lights
// need no tinting). Colors only — no window state crosses this channel.

interface OverlayTint {
  color?: string
  symbolColor?: string
}

export function registerShellChrome(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(ShellChannels.titlebarOverlay, (_e, tint: OverlayTint) => {
    const win = getWin()
    if (!win || process.platform === 'darwin') return
    try {
      win.setTitleBarOverlay({
        color: typeof tint?.color === 'string' ? tint.color : undefined,
        symbolColor: typeof tint?.symbolColor === 'string' ? tint.symbolColor : undefined
      })
    } catch {
      /* no overlay on this window/platform — nothing to tint */
    }
  })
}
