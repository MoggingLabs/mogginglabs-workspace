import { app, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsStore, isSqliteCorruption, corruptAsidePath, corruptSidecars } from '@backend/features/workspace'
import { clearGrant } from '@backend/features/integrations'
import {
  WorkspaceChannels,
  type WorkspaceExportResult,
  type WorkspaceSaveResult,
  type WorkspaceState
} from '@contracts'
import { maybeFault, persistFault } from './fault-port'
import { exportPathOverride } from './fixture-port'
import { armBootResumeIntentsOnce, noteWorkspaceSave } from './session-restore'

// App-wiring: persist app-level workspace state and non-secret feature desired state via the
// 03 store mechanism (better-sqlite3), in a main-owned db separate from daemon sessions.
// Provider credentials never enter this database (ADR 0002).

let store: SettingsStore | null = null
let storeOpenReason = ''
/** Where a corrupt store was moved aside, when one was. Recorded rather than swallowed:
 *  a fresh database opens cleanly, so without this "all my workspaces vanished" has no
 *  evidence anywhere — and the set-aside file IS the recovery path. */
let storeResetFrom = ''

/**
 * Open the settings store, recovering from a CORRUPT file rather than dying on it.
 *
 * A throw here used to leave store = null for the whole process lifetime. That is every
 * workspace, layout, board and profile — persistence simply stopped, permanently, and the
 * only recovery was deleting the file by hand. The daemon already had this recovery for
 * its own store (pty-daemon/index.ts); the app, which holds far more of the user's work,
 * did not.
 *
 * Only corruption moves the file, for the reason isSqliteCorruption exists: a lock or a
 * transient fault can clear, and moving the file on one throws away a healthy store.
 */
function openSettingsStore(dbPath: string): SettingsStore {
  try {
    return new SettingsStore(dbPath)
  } catch (e) {
    if (!isSqliteCorruption(e)) throw e
    const aside = corruptAsidePath(dbPath, Date.now())
    try {
      renameSync(dbPath, aside)
      // The journal goes with it, or the fresh database inherits the old file's
      // uncommitted tail — a clean start that carries the corruption forward.
      for (const side of corruptSidecars(dbPath)) {
        try {
          renameSync(side, corruptAsidePath(side, Date.now()))
        } catch {
          /* no journal beside it */
        }
      }
    } catch {
      /* locked or already gone — the fresh open below decides */
    }
    console.error('[persistence] settings store was corrupt; set aside at ' + aside)
    storeResetFrom = aside
    return new SettingsStore(dbPath)
  }
}
const debugCounters = { loads: 0, saves: 0, exports: 0 }

const GONE_CANDIDATES_KEY = 'workspaces.goneCandidates' // deferred grant-sweep (see sweepGoneWorkspaces)

/** The slice of the store the deferred sweep touches. Named so a unit test can stand one
 *  up without a real sqlite file — the sweep is the whole of the fix and must be pinnable. */
export type GoneSweepStore = Pick<SettingsStore, 'getSetting' | 'setSetting' | 'removeAgentConfigTarget'>

/**
 * DEFERRED sweep of a departed workspace's integration grant and agent-config overrides.
 *
 * A workspace absent from this save may only be SOFT-closed: softClose drops the id from
 * `order` (which `list()` reads) immediately, but keeps its panes alive for the ~5s undo
 * window. Sweeping its grant/config on that FIRST shrinking save destroyed them before the
 * user could Undo, and Undo did not restore them (an S1 data loss). So a workspace becomes a
 * CANDIDATE on the save that first loses it, and is swept only on a LATER save where it is
 * STILL gone (past the grace) — a candidate that reappears (Undo) is dropped unswept.
 *
 * The candidate set is PERSISTED, not re-derived from `previous`: after the first shrinking
 * save `previous` no longer holds the id, so a previous-diff would never sweep a
 * truly-deleted workspace at all.
 */
export function sweepGoneWorkspaces(
  s: GoneSweepStore,
  previousIds: readonly string[],
  presentIds: Iterable<string>
): void {
  const present = new Set(presentIds)
  try {
    let candidates: string[] = []
    try {
      const raw = s.getSetting(GONE_CANDIDATES_KEY)
      if (raw) candidates = (JSON.parse(raw) as unknown[]).filter((id): id is string => typeof id === 'string')
    } catch {
      /* corrupt candidate list — start clean rather than throw */
    }
    // Prior candidates still absent = truly gone (past the grace): sweep them now. Their
    // grants (`integrations.grant.<wsId>`) are keyed by workspace id and would otherwise
    // outlive them — and workspace ids come back (the ordinal math in integrations.ts
    // resolves them), silently resurrecting a writeTools/actOrigins set the user granted to
    // something they deleted. A grant must not outlive its workspace.
    for (const id of candidates.filter((id) => !present.has(id))) {
      clearGrant({ get: (k) => s.getSetting(k), set: (k, v) => s.setSetting(k, v) }, id)
      // A project/local/session intent must not resurrect if this workspace id
      // is later reused for a different directory (same custody rule as grants).
      s.removeAgentConfigTarget('project', id)
      s.removeAgentConfigTarget('local', id)
      s.removeAgentConfigTarget('session', id)
    }
    // Next candidate set: anything gone as of THIS save (kept, not swept, so a soft-close
    // followed by Undo is safe); a candidate that reappeared is simply not carried forward.
    const goneNow = previousIds.filter((id) => !present.has(id))
    s.setSetting(GONE_CANDIDATES_KEY, JSON.stringify([...new Set(goneNow)]))
  } catch {
    /* best effort — stale feature state must never block a workspace save */
  }
}

export function registerAppSettings(): void {
  try {
    // The PERSISTHEALTH gate's three broken moments (open/load/save) arrive through the fault
    // port — inert, and injector-free, in the shipped app (finding 41; src/main/fault-port.ts).
    const openFault = persistFault('open')
    if (openFault) throw new Error(openFault)
    store = openSettingsStore(join(app.getPath('userData'), 'app-settings.db'))
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
    const state = store.load()
    // The boot restore relaunches every lineup with `resume: true` — arm its
    // exact-session intents (once per run, intersection-guarded) so a cold-daemon
    // restart resumes each pane's OWN session instead of the CLI's picker
    // (session-restore.ts, audit 2026-08-02).
    armBootResumeIntentsOnce(state)
    return state
  })
  ipcMain.handle(WorkspaceChannels.saveState, (_e, state: WorkspaceState) => {
    debugCounters.saves++
    const s = store
    if (!s) return { ok: false, reason: 'The workspace store is unavailable.' } satisfies WorkspaceSaveResult
    const saveFault = persistFault('save')
    if (saveFault) return { ok: false, reason: saveFault } satisfies WorkspaceSaveResult
    // Deleting a workspace is just a saveState without it, so THIS is the only place that can
    // see one go — but it cannot tell a delete from a soft-close still inside its undo grace,
    // which is why the sweep is deferred a save (sweepGoneWorkspaces).
    try {
      const previous = s.load()
      const previousIds = (previous.workspaces ?? []).map((w) => w.id)
      const presentIds = state.workspaces.map((w) => w.id)
      s.save(state)
      // The last-working-session snapshot rides every save (shrink-hold semantics live
      // in session-restore.ts). AFTER s.save so a failed save never mirrors, BEFORE the
      // grant sweep so a sweep error can't starve it; best-effort by its own contract.
      noteWorkspaceSave(previous, state)
      sweepGoneWorkspaces(s, previousIds, presentIds)
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
  storeResetFrom = ''
}

/** The path a corrupt settings store was set aside to this launch, or ''. The user's
 *  data is in that file; nothing else records where it went. */
export function settingsStoreResetFrom(): string {
  return storeResetFrom
}

/** The shared app-settings store (also backs 06b provider-mix templates). */
export function getSettingsStore(): SettingsStore | null {
  return store
}

/** Read-only counters for the persistence failure-injection gate. */
export function appSettingsDebug(): Readonly<typeof debugCounters & { resetFrom: string }> {
  return { ...debugCounters, resetFrom: storeResetFrom }
}
