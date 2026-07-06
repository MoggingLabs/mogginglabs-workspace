import { ipcMain, type BrowserWindow } from 'electron'
import {
  IntegrationsChannels,
  type WorkspaceIntegrationsGrant
} from '@contracts'
import { grantedWriteToolNames, readGrant, writeGrant, type GrantKv } from '@backend/features/integrations'
import { getSettingsStore } from './app-settings'

// App-wiring for the per-workspace integrations grant (Phase-8/03, ADR
// 0008.c). Storage rides the app-settings KV via the @backend store; this file
// adds the renderer IPC, the change fan-out (renderer push + the app-endpoint
// broadcast that tells live MCP sessions to re-resolve), and the pane ->
// workspace -> granted-write-tools resolution the endpoint serves to the
// server. The DAEMON stays v3 and grant-blind — resolution is app-side only.

const kv = (): GrantKv | null => {
  const store = getSettingsStore()
  if (!store) return null
  return { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }
}

type GrantListener = () => void
const listeners = new Set<GrantListener>()

/** Subscribe to any grant change (the mcp-endpoint broadcasts `grantChanged`). */
export function onIntegrationsGrantChanged(fn: GrantListener): void {
  listeners.add(fn)
}

export function getIntegrationsGrant(workspaceId: string): WorkspaceIntegrationsGrant {
  const store = kv()
  if (!store) return { workspaceId, writeTools: 'none', web: 'off', actOrigins: [] }
  return readGrant(store, String(workspaceId))
}

let winGetter: (() => BrowserWindow | null) | null = null

/** Persist a (sanitized) grant and fan the change out: renderer push + every
 *  registered listener. Returns the sanitized grant, or null without a store. */
export function setIntegrationsGrant(grant: WorkspaceIntegrationsGrant): WorkspaceIntegrationsGrant | null {
  const store = kv()
  if (!store) return null
  const clean = writeGrant(store, grant)
  try {
    winGetter?.()?.webContents.send(IntegrationsChannels.grantChanged, clean)
  } catch {
    /* window gone; the KV is still the truth */
  }
  for (const fn of listeners) fn()
  return clean
}

/** Resolve a pane's workspace + granted write-tool names — what the app
 *  endpoint serves to `grant.get`. Pane ids encode their workspace ordinal
 *  (ordinal*100+slot, the house convention); an unresolvable pane fails
 *  CLOSED: no workspace, no write tools. */
export function resolveGrantedWriteTools(pane: string): { workspaceId?: string; writeTools: string[] } {
  const paneNum = Number(pane)
  if (!Number.isInteger(paneNum) || paneNum <= 0) return { writeTools: [] } // slots start at 1; garbage fails closed
  const ordinal = Math.floor(paneNum / 100) // the FIRST workspace's ordinal is 0
  const ws = getSettingsStore()
    ?.load()
    ?.workspaces.find((w) => w.ordinal === ordinal)
  if (!ws) return { writeTools: [] }
  return { workspaceId: ws.id, writeTools: grantedWriteToolNames(getIntegrationsGrant(ws.id)) }
}

export function registerIntegrations(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  ipcMain.handle(IntegrationsChannels.grantGet, (_e, workspaceId: string) =>
    getIntegrationsGrant(String(workspaceId))
  )
  ipcMain.handle(IntegrationsChannels.grantSet, (_e, grant: WorkspaceIntegrationsGrant) =>
    setIntegrationsGrant(grant)
  )
}
