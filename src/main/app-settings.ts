import { app, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SettingsStore } from '@backend/features/workspace'
import { clearGrant } from '@backend/features/integrations'
import {
  WorkspaceChannels,
  type WorkspaceExportResult,
  type WorkspaceSaveResult,
  type WorkspaceState
} from '@contracts'
import { maybeFault, persistFault } from './fault-port'
import { exportPathOverride } from './fixture-port'

// App-wiring: persist app-level workspace state (tabs + theme) via the 03 store mechanism
// (better-sqlite3), in a main-owned db separate from the daemon's sessions. Metadata only —
// never credentials (ADR 0002).

let store: SettingsStore | null = null
let storeOpenReason = ''
const debugCounters = { loads: 0, saves: 0, exports: 0 }

export function registerAppSettings(): void {
  try {
    // The PERSISTHEALTH gate's three broken moments (open/load/save) arrive through the fault
    // port — inert, and injector-free, in the shipped app (finding 41; src/main/fault-port.ts).
    const openFault = persistFault('open')
    if (openFault) throw new Error(openFault)
    store = new SettingsStore(join(app.getPath('userData'), 'app-settings.db'))
    storeOpenReason = ''
  } catch (error) {
    store = null
    storeOpenReason = error instanceof Error ? error.message : String(error)
    console.error('[persistence] workspace store unavailable', error)
  }
  ipcMain.handle(WorkspaceChannels.loadState, async () => {
    // Finding 39's seam: Home's recents come from here, so the ASYNCSTATE gate must be able to
    // reject/hang/delay this READ for real — no stub, the same handler the launcher calls.
    await maybeFault(WorkspaceChannels.loadState)
    debugCounters.loads++
    const loadFault = persistFault('load')
    if (loadFault) throw new Error(loadFault)
    if (!store) throw new Error(storeOpenReason || 'The workspace store is unavailable.')
    return store.load()
  })
  ipcMain.handle(WorkspaceChannels.saveState, (_e, state: WorkspaceState) => {
    debugCounters.saves++
    const s = store
    if (!s) return { ok: false, reason: 'The workspace store is unavailable.' } satisfies WorkspaceSaveResult
    const saveFault = persistFault('save')
    if (saveFault) return { ok: false, reason: saveFault } satisfies WorkspaceSaveResult
    // Deleting a workspace is just a saveState without it, so THIS is the only place that can
    // see one go. Its integration grants (`integrations.grant.<wsId>`) are keyed by workspace
    // id and would otherwise outlive it — and workspace ids can come back (the ordinal math in
    // integrations.ts resolves them), silently resurrecting a writeTools/actOrigins set the
    // user granted to something they deleted. A grant must not outlive its workspace.
    try {
      const gone = (s.load().workspaces ?? []).filter((old) => !state.workspaces.some((w) => w.id === old.id))
      s.save(state)
      for (const w of gone) {
        try {
          clearGrant({ get: (k) => s.getSetting(k), set: (k, v) => s.setSetting(k, v) }, w.id)
        } catch {
          /* best effort — a stale grant must never block a save */
        }
      }
      return { ok: true } satisfies WorkspaceSaveResult
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error)
      } satisfies WorkspaceSaveResult
    }
  })
  ipcMain.handle(WorkspaceChannels.exportState, async (_e, state: WorkspaceState): Promise<WorkspaceExportResult> => {
    debugCounters.exports++
    try {
      // A gate cannot click a native save dialog; the harness hands us the path instead
      // (src/main/fixture-port.ts). Null in the shipped app — the dialog is the only door.
      const forced = exportPathOverride()
      const picked = forced
        ? { canceled: false, filePath: forced }
        : await dialog.showSaveDialog({
            title: 'Export current workspace metadata',
            defaultPath: `mogging-workspaces-${new Date().toISOString().slice(0, 10)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }]
          })
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
      await writeFile(picked.filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
      return { ok: true, path: picked.filePath }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })
}

export function disposeAppSettings(): void {
  store?.close()
  store = null
  storeOpenReason = ''
}

/** The shared app-settings store (also backs 06b provider-mix templates). */
export function getSettingsStore(): SettingsStore | null {
  return store
}

/** Read-only counters for the persistence failure-injection gate. */
export function appSettingsDebug(): Readonly<typeof debugCounters> {
  return { ...debugCounters }
}
