import { clipboard, ipcMain } from 'electron'
import { ClipboardChannels } from '@contracts'
import type { WriteClipboard } from '@contracts'

// System clipboard IPC. App-layer wiring: Electron's clipboard is a main-process API,
// and @backend must stay Electron-free — so this registers directly on ipcMain rather
// than through a backend FeatureModule.
export function registerClipboard(): void {
  ipcMain.handle(ClipboardChannels.write, (_e, payload: WriteClipboard) => {
    clipboard.writeText(payload?.text ?? '')
  })
  ipcMain.handle(ClipboardChannels.read, () => clipboard.readText())
}
