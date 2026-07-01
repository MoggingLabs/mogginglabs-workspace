import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from '@backend/features/workspace'
import { WorkspaceChannels, type WorkspaceState } from '@contracts'

// App-wiring: persist app-level workspace state (tabs + theme) via the 03 store mechanism
// (better-sqlite3), in a main-owned db separate from the daemon's sessions. Metadata only —
// never credentials (ADR 0002).

let store: SettingsStore | null = null

export function registerAppSettings(): void {
  store = new SettingsStore(join(app.getPath('userData'), 'app-settings.db'))
  ipcMain.handle(WorkspaceChannels.loadState, () => store?.load())
  ipcMain.handle(WorkspaceChannels.saveState, (_e, state: WorkspaceState) => {
    store?.save(state)
  })
}

export function disposeAppSettings(): void {
  store?.close()
  store = null
}
