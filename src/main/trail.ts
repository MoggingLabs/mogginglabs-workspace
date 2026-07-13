import { app, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TrailStore } from '@backend/features/integrations'
import { IntegrationsChannels, type TrailEntry } from '@contracts'
import { maybeFault } from './fault-port'

// The agent activity trail's ONE emission point (Phase-8/03 stub; 8/05 wires
// the real store — FINDINGS §4.5). Every receipt/act flows through here: one
// emission, two sinks (the house notify receipt + this). Entries are REFS
// only, never content (@contracts TrailEntry; the store length-caps every
// field). LOCAL forever: the only IPC is the viewer's read/clear/export —
// nothing here may ever reach telemetry, and a write failure never blocks an
// action (evidence, not enforcement).

let store: TrailStore | null = null
const trailStore = (): TrailStore => {
  if (!store) store = new TrailStore(join(app.getPath('userData'), 'trail'))
  return store
}

/** Fire-and-forget: queued + idle-flushed off the hot path. Never throws. */
export function recordTrail(entry: TrailEntry): void {
  try {
    trailStore().append(entry)
  } catch {
    /* the store logs its own one loud line; an act is never blocked */
  }
}

/** Read one workspace's entries (oldest first), or every workspace's. */
export function readTrail(workspaceId?: string): TrailEntry[] {
  const s = trailStore()
  if (workspaceId) return s.read(workspaceId)
  return s
    .listWorkspaces()
    .flatMap((ws) => s.read(ws))
    .sort((a, b) => a.ts - b.ts)
}

export function clearTrail(workspaceId: string): void {
  if (workspaceId) trailStore().clear(workspaceId)
}

/** Smoke-only: force the idle queue to disk so raw-file asserts are exact. */
export function flushTrailForSmoke(): void {
  trailStore().flush()
}

export function registerTrail(): void {
  ipcMain.handle(IntegrationsChannels.trailList, async (_e, workspaceId: string) => {
    // Finding 39's seam: Activity's read. The gate DELAYS call #1 past call #2 here — the only way
    // to prove a generation guard is to make the past arrive after the future.
    await maybeFault(IntegrationsChannels.trailList)
    return readTrail(String(workspaceId ?? '') || undefined)
  })
  ipcMain.handle(IntegrationsChannels.trailClear, (_e, workspaceId: string) => clearTrail(String(workspaceId ?? '')))
  // Export = a LOCAL save dialog; the file goes where the user points, and
  // nowhere else. Returns true when saved.
  ipcMain.handle(IntegrationsChannels.trailExport, async (_e, workspaceId: string) => {
    const entries = readTrail(String(workspaceId ?? '') || undefined)
    const pick = await dialog.showSaveDialog({
      title: 'Export agent activity trail',
      defaultPath: `agent-trail-${String(workspaceId ?? '') || 'all'}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (pick.canceled || !pick.filePath) return false
    try {
      writeFileSync(pick.filePath, JSON.stringify(entries, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  })
}
