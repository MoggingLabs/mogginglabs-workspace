import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { SettingsStore } from '@backend/features/workspace'
import { clearGrant } from '@backend/features/integrations'
import { WorkspaceChannels, type WorkspaceState } from '@contracts'

// App-wiring: persist app-level workspace state and non-secret feature desired state via the
// 03 store mechanism (better-sqlite3), in a main-owned db separate from daemon sessions.
// Provider credentials never enter this database (ADR 0002).

let store: SettingsStore | null = null

export function registerAppSettings(): void {
  store = new SettingsStore(join(app.getPath('userData'), 'app-settings.db'))
  ipcMain.handle(WorkspaceChannels.loadState, () => store?.load())
  ipcMain.handle(WorkspaceChannels.saveState, (_e, state: WorkspaceState) => {
    const s = store
    if (!s) return
    // Deleting a workspace is just a saveState without it, so THIS is the only place that can
    // see one go. Its integration grants (`integrations.grant.<wsId>`) are keyed by workspace
    // id and would otherwise outlive it — and workspace ids can come back (the ordinal math in
    // integrations.ts resolves them), silently resurrecting a writeTools/actOrigins set the
    // user granted to something they deleted. A grant must not outlive its workspace.
    const gone = (s.load().workspaces ?? []).filter((old) => !state.workspaces.some((w) => w.id === old.id))
    s.save(state)
    for (const w of gone) {
      try {
        clearGrant({ get: (k) => s.getSetting(k), set: (k, v) => s.setSetting(k, v) }, w.id)
        // A project/local/session intent must not resurrect if this workspace id
        // is later reused for a different directory (same custody rule as grants).
        s.removeAgentConfigTarget('project', w.id)
        s.removeAgentConfigTarget('local', w.id)
        s.removeAgentConfigTarget('session', w.id)
      } catch {
        /* best effort — stale feature state must never block a workspace save */
      }
    }
  })
}

export function disposeAppSettings(): void {
  store?.close()
  store = null
}

/** The shared app-settings store (also backs 06b provider-mix templates). */
export function getSettingsStore(): SettingsStore | null {
  return store
}
