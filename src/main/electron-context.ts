import { ipcMain, type WebContents } from 'electron'
import type { BackendContext } from '@backend'

/**
 * The Electron implementation of BackendContext — the ONLY file that binds the
 * backend to Electron's ipcMain / webContents. To run the backend in a dedicated
 * utilityProcess (Phase 1) or a headless test, provide a different context here;
 * no feature code changes.
 */
export function createElectronContext(getWebContents: () => WebContents | null): BackendContext {
  return {
    handle: (channel, handler) => {
      ipcMain.handle(channel, (_e, payload) => handler(payload))
    },
    on: (channel, handler) => {
      ipcMain.on(channel, (_e, payload) => handler(payload))
    },
    emit: (channel, payload) => {
      // A destroyed webContents throws on send, and a backend event can land in the gap between
      // the window's destruction and the 'closed' that nulls the getter's window — inside
      // installFatalHandlers' uncaughtException, which exits the app. Closing a window while
      // agents stream output must not kill the process.
      const wc = getWebContents()
      if (wc && !wc.isDestroyed()) wc.send(channel, payload)
    }
  }
}
