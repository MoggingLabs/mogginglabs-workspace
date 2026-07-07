import { ipcMain, type BrowserWindow } from 'electron'
import {
  IntegrationsChannels,
  defaultToolPlan,
  sanitizeToolPlan,
  type WorkspaceIntegrationsGrant,
  type WorkspaceToolPlan
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

// ── The per-workspace tool plan (Phase-8/09) ────────────────────────────────
const PLAN_KEY = (workspaceId: string): string => `integrations.toolplan.${workspaceId}`
const planListeners = new Set<() => void>()
export function onToolPlanChanged(fn: () => void): void {
  planListeners.add(fn)
}
export function getToolPlan(workspaceId: string): WorkspaceToolPlan {
  const raw = getSettingsStore()?.getSetting(PLAN_KEY(String(workspaceId)))
  if (!raw) return defaultToolPlan(String(workspaceId))
  try {
    return sanitizeToolPlan(JSON.parse(raw), String(workspaceId))
  } catch {
    return defaultToolPlan(String(workspaceId))
  }
}

/** Has a plan ever been STORED for this workspace? Scoping is OPT-IN: a
 *  workspace with no stored plan launches unchanged (the CLI's own global
 *  config), so 8/09 never silently strips a pre-existing user's servers. A new
 *  workspace stores its plan at creation, which is what turns scoping on. */
export function hasToolPlan(workspaceId: string): boolean {
  return !!getSettingsStore()?.getSetting(PLAN_KEY(String(workspaceId)))
}

/** How many workspaces plan each server (for the catalog's "in N of M
 *  workspaces" badge, 8/09 step 4). `total` = workspaces that have a stored
 *  plan (the honest denominator — un-scoped workspaces aren't in the count). */
export function toolPlanCoverage(): { counts: Record<string, number>; total: number } {
  const workspaces = getSettingsStore()?.load()?.workspaces ?? []
  const counts: Record<string, number> = {}
  let total = 0
  for (const w of workspaces) {
    if (!hasToolPlan(w.id)) continue
    total++
    for (const id of Object.keys(getToolPlan(w.id).entries)) counts[id] = (counts[id] ?? 0) + 1
  }
  return { counts, total }
}
export function setToolPlan(plan: WorkspaceToolPlan): WorkspaceToolPlan {
  const clean = sanitizeToolPlan(plan, String(plan?.workspaceId ?? ''))
  getSettingsStore()?.setSetting(PLAN_KEY(clean.workspaceId), JSON.stringify(clean))
  for (const fn of planListeners) fn()
  try {
    winGetter?.()?.webContents.send(IntegrationsChannels.planChanged, clean)
  } catch {
    /* window gone; the KV is the truth */
  }
  return clean
}

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
  const wsId = workspaceIdForPane(pane)
  if (!wsId) return { writeTools: [] }
  return { workspaceId: wsId, writeTools: grantedWriteToolNames(getIntegrationsGrant(wsId)) }
}

/** The workspace a pane belongs to (ordinal*100+slot, the house convention).
 *  Undefined when unresolvable — callers fail CLOSED. Used to route an agent's
 *  browser control to its OWN workspace's browser (8/07c). */
export function workspaceIdForPane(pane: string): string | undefined {
  const paneNum = Number(pane)
  if (!Number.isInteger(paneNum) || paneNum <= 0) return undefined // slots start at 1
  const ordinal = Math.floor(paneNum / 100) // the FIRST workspace's ordinal is 0
  return getSettingsStore()
    ?.load()
    ?.workspaces.find((w) => w.ordinal === ordinal)?.id
}

export function registerIntegrations(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  ipcMain.handle(IntegrationsChannels.grantGet, (_e, workspaceId: string) =>
    getIntegrationsGrant(String(workspaceId))
  )
  ipcMain.handle(IntegrationsChannels.grantSet, (_e, grant: WorkspaceIntegrationsGrant) =>
    setIntegrationsGrant(grant)
  )
  ipcMain.handle(IntegrationsChannels.planGet, (_e, workspaceId: string) => getToolPlan(String(workspaceId)))
  ipcMain.handle(IntegrationsChannels.planSet, (_e, plan: WorkspaceToolPlan) => setToolPlan(plan))
  ipcMain.handle(IntegrationsChannels.planCoverage, () => toolPlanCoverage())
}
