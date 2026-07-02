import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { WorkspaceChannels } from '@contracts'

// App-wiring: native OS dialogs stay in main (the renderer is sandboxed — ADR 0004).
// `workspace:browseDir` backs the wizard's working-folder picker: one native directory
// chooser, resolving to an absolute path or null on cancel. Nothing here reads file
// contents — it only returns the user's chosen path.

export function registerDialogs(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(WorkspaceChannels.browseDir, async () => {
    const win = getWin()
    const opts = {
      title: 'Choose a working folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
}
