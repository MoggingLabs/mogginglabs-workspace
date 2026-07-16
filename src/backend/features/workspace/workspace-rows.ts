import type { WorkspaceStateMeta } from '@contracts'

// The PURE half of workspace persistence: WorkspaceStateMeta <-> the app_workspaces row
// shape, with no sqlite in sight — so the unit tier (tests/unit/workspace-rows.test.ts)
// can bite on the exact failure this extraction answers for. WorkspaceStateMeta.paneIds
// (a pane MOVED between workspaces keeps its id — its daemon session key) was carried by
// the contract, sent by the renderer, and consumed by restore, but the row mapping in the
// store simply never included it: the field round-tripped as `undefined`, and after a
// restart the moved pane's session was orphaned in the daemon while a duplicate shell
// spawned at the formula id. A dropped field must fail a test, not a user.

/** Guarded JSON parse for one nullable TEXT cell: one corrupt cell drops that FIELD,
 *  never the row — and never throws out of load(). A throwing load() looks like a
 *  brand-new install to the renderer, whose next save (DELETE FROM app_workspaces)
 *  would wipe every intact row. Corruption must degrade, not cascade. */
export function parseJsonCell<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** One workspace row as the app_workspaces table stores it (JSON-encoded list cells). */
export interface WorkspaceRowCells {
  id: string
  name: string
  color: string
  cwd: string
  ordinal: number
  paneCount: number
  layoutTree: string | null
  assignments: string | null
  paneCwds: string | null
  paneRoles: string | null
  paneRemotes: string | null
  paneProfileIds: string | null
  paneIds: string | null
}

const cell = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))

/** Meta -> row cells. Absent optional fields persist as NULL, so an untouched
 *  workspace's stored bytes are identical to what they were before a field existed. */
export function workspaceMetaToRow(w: WorkspaceStateMeta): WorkspaceRowCells {
  return {
    id: w.id,
    name: w.name,
    color: w.color,
    cwd: w.cwd,
    ordinal: w.ordinal,
    paneCount: w.paneCount,
    layoutTree: w.layout ?? null,
    assignments: cell(w.assignments),
    paneCwds: cell(w.paneCwds),
    paneRoles: cell(w.roles),
    paneRemotes: cell(w.remotes),
    paneProfileIds: cell(w.profileIds),
    paneIds: cell(w.paneIds)
  }
}

/** Row cells -> meta. Per-field guarded parses (see parseJsonCell). */
export function workspaceRowToMeta(r: WorkspaceRowCells): WorkspaceStateMeta {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    cwd: r.cwd,
    ordinal: r.ordinal,
    paneCount: r.paneCount,
    layout: r.layoutTree ?? undefined,
    assignments: parseJsonCell<string[]>(r.assignments),
    paneCwds: parseJsonCell<(string | null)[]>(r.paneCwds),
    roles: parseJsonCell<(string | null)[]>(r.paneRoles),
    remotes: parseJsonCell<({ hostId: string; name: string; cwd?: string } | null)[]>(r.paneRemotes),
    profileIds: parseJsonCell<(string | null)[]>(r.paneProfileIds),
    paneIds: parseJsonCell<(number | null)[]>(r.paneIds)
  }
}
