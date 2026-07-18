import { ipcMain, type BrowserWindow } from 'electron'
import { ShellChannels, type WindowStateEvent } from '@contracts'

// App-wiring: keep the native window-control overlay tinted to the active theme so the
// frameless header reads as one organic surface (Windows/Linux; macOS traffic lights
// need no tinting). Colors only — no window state crosses this channel.
//
// A `shell:hostInfo` channel briefly lived here, so the renderer could ask main for the OS
// build and hand xterm a `windowsPty`. It is gone: the pty's emulation now rides the
// daemon's own `spawned` answer (protocol v4 — SpawnResult.pty), which is the only place
// that KNOWS it. Main inferring it from `process.platform` was a guess that could disagree
// with the process actually holding the pty.

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

/** A press on native chrome never reaches the DOM: -webkit-app-region: drag hands the
 *  pointer to the OS before the renderer sees any event, so outside-click dismissers
 *  (the pane ⋯ menu, the layout/usage popovers) stayed open when the user clicked the
 *  title bar. Main DOES see it: on Windows every non-client press arrives as a
 *  WM_NC*BUTTONDOWN window message (drag strip AND the window-control overlay, even
 *  when the window never moves), and on every platform a drag/resize that actually
 *  starts announces itself via will-move / will-resize. Forward ONE signal per
 *  gesture; app-shell replays it into the DOM as a synthetic pointerdown. */
export function wireChromePress(win: BrowserWindow): void {
  let last = 0
  const push = (): void => {
    if (win.isDestroyed()) return
    // will-move/will-resize STREAM for the whole drag; one dismissal per gesture is
    // the whole job, so collapse the burst instead of spamming IPC every frame.
    const now = Date.now()
    if (now - last < 150) return
    last = now
    win.webContents.send(ShellChannels.chromePress, null)
  }
  if (process.platform === 'win32') {
    // WM_NCLBUTTONDOWN / RBUTTONDOWN / MBUTTONDOWN. hookWindowMessage observes the
    // message, it does not consume it — dragging and the control buttons still work.
    for (const msg of [0x00a1, 0x00a4, 0x00a7]) win.hookWindowMessage(msg, push)
  }
  // Cross-platform (and the whole macOS path — Cocoa has no NC messages): a drag or
  // resize that actually starts. A macOS press that never moves stays invisible; the
  // platform offers no event for it, and blur/resize already cover the other exits.
  win.on('will-move', push)
  win.on('will-resize', push)
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
