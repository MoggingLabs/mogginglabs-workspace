import type { HostedCliId } from './presets'

// The per-workspace TOOL PLAN (Phase-8/09). Registered ≠ everywhere: a plan
// says WHICH registered servers reach a workspace's panes, per CLI, so an
// agent's context carries only what the work needs — not every connected tool.
// MINIMAL by default: a fresh plan is EMPTY (the house server is always present
// and the template's picks seed it) — never auto-add beyond that. Scoping is
// CONTEXT hygiene, not a security boundary (the reviewer gate + grants stay the
// boundary; a plan never widens a grant).

/** A server's reach: every CLI, or a specific set. */
export type ToolPlanScope = 'all-clis' | HostedCliId[]

export interface WorkspaceToolPlan {
  workspaceId: string
  /** serverId -> which CLIs it lands on. Absent server = not in the plan. */
  entries: Record<string, ToolPlanScope>
  /** Also inherit the GLOBAL tier (the 06 user-home writes, "everywhere").
   *  false by default — the plan is the whole story unless the user opts in. */
  inheritGlobal: boolean
}

/** Atomic UI mutation against the latest plan (never a captured stale matrix). */
export type ToolPlanMutation =
  | { workspaceId: string; kind: 'inherit'; value: boolean }
  | { workspaceId: string; kind: 'cell'; serverId: string; cli: HostedCliId; enabled: boolean }

export function defaultToolPlan(workspaceId: string): WorkspaceToolPlan {
  return { workspaceId, entries: {}, inheritGlobal: false }
}

/** A new workspace's starting plan: the template's picks (every CLI), nothing
 *  else — MINIMAL by default (the house server is always present besides). */
export function planFromTemplateTools(workspaceId: string, tools: readonly string[] | undefined): WorkspaceToolPlan {
  const entries: Record<string, ToolPlanScope> = {}
  for (const id of tools ?? []) if (/^[a-z0-9_-]{1,64}$/i.test(id)) entries[id] = 'all-clis'
  return { workspaceId, entries, inheritGlobal: false }
}

/** Does this server land on this CLI per the plan? */
export function planHasServerForCli(plan: WorkspaceToolPlan, serverId: string, cli: HostedCliId): boolean {
  const scope = plan.entries[serverId]
  if (!scope) return false
  return scope === 'all-clis' || scope.includes(cli)
}

/** The server ids the plan lands on this CLI (order-stable). */
export function plannedServerIdsForCli(plan: WorkspaceToolPlan, cli: HostedCliId): string[] {
  return Object.keys(plan.entries).filter((id) => planHasServerForCli(plan, id, cli))
}

/** A cell state for the tools × CLIs matrix (settings §Integrations, 09/step 4). */
export type ToolCellState = 'global' | 'planned' | 'off'

export function toolCellState(
  plan: WorkspaceToolPlan,
  serverId: string,
  cli: HostedCliId,
  isGlobalForCli: boolean
): ToolCellState {
  if (planHasServerForCli(plan, serverId, cli)) return 'planned'
  if (isGlobalForCli && plan.inheritGlobal) return 'global'
  return 'off'
}

/** A stable signature of a plan — any edit (entries or inheritGlobal) changes
 *  it. A pane launched at signature X needs a RESTART once its workspace's plan
 *  moves to a different signature (its running CLI still holds the old set). */
export function planSignature(plan: WorkspaceToolPlan): string {
  const entries = Object.keys(plan.entries)
    .sort()
    .map((k) => {
      const v = plan.entries[k]
      return `${k}:${v === 'all-clis' ? 'all' : [...v].sort().join(',')}`
    })
  return `${plan.inheritGlobal ? 'g' : '-'}|${entries.join(';')}`
}

/** Of the live panes (each carrying the plan signature it launched with), which
 *  need a restart to pick up `currentSig`. Empty when nothing changed. */
export function restartNeededPanes(panes: readonly { paneId: number; launchSig: string }[], currentSig: string): number[] {
  return panes.filter((p) => p.launchSig !== currentSig).map((p) => p.paneId)
}

/** Sanitize a persisted/plan-wire object into a valid WorkspaceToolPlan. */
export function sanitizeToolPlan(raw: unknown, workspaceId: string): WorkspaceToolPlan {
  const p = (raw ?? {}) as Record<string, unknown>
  const entries: Record<string, ToolPlanScope> = {}
  const rawEntries = (p.entries ?? {}) as Record<string, unknown>
  if (rawEntries && typeof rawEntries === 'object') {
    for (const [id, scope] of Object.entries(rawEntries)) {
      if (!/^[a-z0-9_-]{1,64}$/i.test(id)) continue
      if (scope === 'all-clis') entries[id] = 'all-clis'
      else if (Array.isArray(scope)) {
        const clis = scope.filter((c): c is HostedCliId => c === 'claude-code' || c === 'codex' || c === 'gemini')
        if (clis.length) entries[id] = clis
      }
    }
  }
  return { workspaceId, entries, inheritGlobal: p.inheritGlobal === true }
}
