import { ipcMain, type BrowserWindow } from 'electron'
import { ShellChannels, type WindowStateEvent } from '@contracts'

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

/** Push fullscreen/maximize state to the renderer — EVENTS only, never polled
 *  (Phase-5/04). State is tracked from the event IDENTITY, not re-queried: on
 *  Windows, `enter-full-screen` fires before `isFullScreen()` flips, so a re-query
 *  inside the handler reports the OLD state (measured — the class never applied).
 *  Sent once after load too, so a reload mid-fullscreen starts correct. */
export function wireWindowState(win: BrowserWindow): void {
  let fullscreen = win.isFullScreen()
  let maximized = win.isMaximized()
  const push = (): void => {
    if (win.isDestroyed()) return
    const state: WindowStateEvent = { fullscreen, maximized }
    win.webContents.send(ShellChannels.windowState, state)
  }
  win.on('enter-full-screen', () => ((fullscreen = true), push()))
  win.on('leave-full-screen', () => ((fullscreen = false), push()))
  win.on('maximize', () => ((maximized = true), push()))
  win.on('unmaximize', () => ((maximized = false), push()))
  win.webContents.on('did-finish-load', () => {
    // A load can happen in any state — re-sync the trackers before pushing.
    fullscreen = win.isFullScreen()
    maximized = win.isMaximized()
    push()
  })
}
