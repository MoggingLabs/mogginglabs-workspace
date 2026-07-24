import { ipcMain, type BrowserWindow } from 'electron'
import {
  IntegrationsChannels,
  defaultToolPlan,
  locatePane,
  sanitizeToolPlan,
  type HostedCliId,
  type IntegrationsGrantMutation,
  type ToolPlanMutation,
  type WorkspaceIntegrationsGrant,
  type WorkspaceToolPlan
} from '@contracts'
import {
  grantedWriteToolNames,
  isBlockedActOrigin,
  normalizeActOrigin,
  readGrant,
  writeGrant,
  type GrantKv
} from '@backend/features/integrations'
import { getSettingsStore } from './app-settings'
import { wizardAuditFaults } from './wizard-audit-faults'
import { maybeMutationFault } from './fault-port'
import { waitForBrowserRaceAudit } from './browser-race-audit-faults'

// App-wiring for the per-workspace integrations grant (Phase-8/03, ADR
// 0008.c). Storage rides the app-settings KV via the @backend store; this file
// adds the renderer IPC, the change fan-out (renderer push + the app-endpoint
// broadcast that tells live MCP sessions to re-resolve), and the pane ->
// workspace -> granted-write-tools resolution the endpoint serves to the
// server. The DAEMON is untouched and grant-blind — resolution is app-side only.

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

export function mutateToolPlan(raw: ToolPlanMutation): WorkspaceToolPlan {
  const mutation = raw as ToolPlanMutation | null
  const workspaceId = String(mutation?.workspaceId ?? '')
  if (!mutation || !workspaceId) return defaultToolPlan('')
  const current = getToolPlan(workspaceId)
  if (mutation.kind === 'inherit') {
    return setToolPlan({ ...current, inheritGlobal: mutation.value === true })
  }
  if (mutation.kind !== 'cell') return current
  const cli = mutation.cli as HostedCliId
  if (!['claude-code', 'codex', 'gemini'].includes(cli) || !/^[a-z0-9_-]{1,64}$/i.test(mutation.serverId)) {
    return current
  }
  const scope = current.entries[mutation.serverId]
  const clis: HostedCliId[] = scope === 'all-clis'
    ? ['claude-code', 'codex', 'gemini']
    : Array.isArray(scope) ? [...scope] : []
  const next = mutation.enabled ? [...new Set([...clis, cli])] : clis.filter((item) => item !== cli)
  const entries = { ...current.entries }
  if (!next.length) delete entries[mutation.serverId]
  else entries[mutation.serverId] = next.length === 3 ? 'all-clis' : next
  return setToolPlan({ ...current, entries })
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

export function mutateIntegrationsGrant(raw: IntegrationsGrantMutation): WorkspaceIntegrationsGrant | null {
  const mutation = raw as IntegrationsGrantMutation | null
  const workspaceId = String(mutation?.workspaceId ?? '')
  if (!mutation || !workspaceId) return null
  const current = getIntegrationsGrant(workspaceId)
  if (mutation.field === 'writeTools') {
    if (mutation.value !== 'none' && mutation.value !== 'all' && !Array.isArray(mutation.value)) return current
    return setIntegrationsGrant({ ...current, writeTools: mutation.value })
  }
  if (mutation.field === 'web') {
    if (!['off', 'public', 'signed-in'].includes(mutation.value)) return current
    return setIntegrationsGrant({ ...current, web: mutation.value })
  }
  if (mutation.field !== 'origin' || (mutation.op !== 'add' && mutation.op !== 'remove')) return current
  const origin = normalizeActOrigin(String(mutation.origin ?? ''))
  if (!origin || isBlockedActOrigin(origin)) return current
  const origins = mutation.op === 'remove'
    ? current.actOrigins.filter((item) => item !== origin)
    : [...new Set([...current.actOrigins, origin])]
  return setIntegrationsGrant({
    ...current,
    web: mutation.op === 'add' ? 'signed-in' : current.web,
    actOrigins: origins
  })
}

/** Resolve a pane's workspace + granted write-tool names — what the app
 *  endpoint serves to `grant.get`. Pane ids encode their workspace ordinal
 *  (locatePane — the house convention, stated once in @contracts); an
 *  unresolvable pane fails CLOSED: no workspace, no write tools. */
/** The REST bridge's write gate (ADR 0021): a `readOnly:false` bridge tool
 *  executes only when the calling workspace's grant says writeTools:'all' —
 *  the SAME grant MCP write tools ride, read at the same seam. Fail-closed:
 *  no pane, no workspace, no grant → no writes. */
export function resolveWriteAllGranted(pane: string | undefined): boolean {
  const wsId = pane ? workspaceIdForPane(pane) : undefined
  return wsId ? getIntegrationsGrant(wsId).writeTools === 'all' : false
}

export function resolveGrantedWriteTools(pane: string): { workspaceId?: string; writeTools: string[] } {
  const wsId = workspaceIdForPane(pane)
  if (!wsId) return { writeTools: [] }
  return { workspaceId: wsId, writeTools: grantedWriteToolNames(getIntegrationsGrant(wsId)) }
}

/** The workspace a pane belongs to. Undefined when unresolvable — callers fail
 *  CLOSED. Used to gate grants and to route an agent's browser control to its
 *  OWN workspace's browser (8/07c).
 *
 *  locatePane, NOT the bare formula: a pane MOVED between workspaces keeps its id
 *  (its daemon session key), and the formula would keep answering with the workspace
 *  it LEFT — which is exactly the wrong workspace to read grants from. The renderer
 *  resolved moves correctly all along; main is now the same one resolver. */
export function workspaceIdForPane(pane: string): string | undefined {
  const paneNum = Number(pane)
  if (!Number.isInteger(paneNum) || paneNum <= 0) return undefined // slots start at 1
  const workspaces = getSettingsStore()?.load()?.workspaces
  if (!workspaces) return undefined
  return locatePane(workspaces, paneNum)?.ws.id
}

export function registerIntegrations(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  ipcMain.handle(IntegrationsChannels.grantGet, async (_e, workspaceId: string) => {
    const wsId = String(workspaceId)
    await waitForBrowserRaceAudit('grantGet', wsId)
    return getIntegrationsGrant(wsId)
  })
  ipcMain.handle(IntegrationsChannels.grantSet, (_e, grant: WorkspaceIntegrationsGrant) =>
    setIntegrationsGrant(grant)
  )
  ipcMain.handle(IntegrationsChannels.grantMutate, async (_e, mutation: IntegrationsGrantMutation) => {
    await maybeMutationFault('grant')
    return mutateIntegrationsGrant(mutation)
  })
  ipcMain.handle(IntegrationsChannels.planGet, (_e, workspaceId: string) => getToolPlan(String(workspaceId)))
  ipcMain.handle(IntegrationsChannels.planSet, (_e, plan: WorkspaceToolPlan) => {
    const fault = wizardAuditFaults()
    if (fault) {
      fault.planSetCalls++
      if (fault.planSetReject) return null
    }
    return setToolPlan(plan)
  })
  ipcMain.handle(IntegrationsChannels.planMutate, async (_e, mutation: ToolPlanMutation) => {
    await maybeMutationFault('plan')
    return mutateToolPlan(mutation)
  })
  ipcMain.handle(IntegrationsChannels.planCoverage, () => toolPlanCoverage())
}
