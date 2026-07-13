import { ipcMain } from 'electron'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
import { BOARD_LANES, BoardChannels, type BoardCard } from '@contracts'

// App-wiring: bind the Kanban board (Phase-3/05) to the app-settings db. Card text is
// USER CONTENT — this file must never forward it to telemetry, notify, or logs
// (ADR 0005); it only round-trips renderer <-> local sqlite.

function sanitizeCard(raw: unknown): BoardCard | null {
  const c = raw as Record<string, unknown> | null
  if (!c || typeof c !== 'object') return null
  if (typeof c.id !== 'string' || !c.id || c.id.length > 64) return null
  if (typeof c.title !== 'string' || typeof c.notes !== 'string') return null
  if (typeof c.lane !== 'string' || !(BOARD_LANES as readonly string[]).includes(c.lane)) return null
  const paneId = c.paneId == null ? null : Number(c.paneId)
  if (paneId !== null && (!Number.isInteger(paneId) || paneId < 0)) return null
  return {
    id: c.id,
    title: c.title.slice(0, 500),
    notes: c.notes.slice(0, 10000),
    lane: c.lane as BoardCard['lane'],
    paneId,
    workspaceId: typeof c.workspaceId === 'string' ? c.workspaceId.slice(0, 64) : null,
    createdAt: Number(c.createdAt) || Date.now(),
    updatedAt: Number(c.updatedAt) || Date.now()
  }
}

export function registerBoard(): void {
  ipcMain.handle(BoardChannels.list, () => getSettingsStore()?.listBoard() ?? [])
  ipcMain.handle(BoardChannels.save, async (_e, raw: unknown) => {
    await maybeFault(BoardChannels.save) // ASYNCSTATE seam (finding 39) — inert unless armed
    const card = sanitizeCard(raw)
    if (card) getSettingsStore()?.saveBoardCard(card)
    return card != null
  })
  ipcMain.handle(BoardChannels.remove, async (_e, id: unknown) => {
    await maybeFault(BoardChannels.remove)
    if (typeof id === 'string' && id) getSettingsStore()?.removeBoardCard(id)
  })
}
