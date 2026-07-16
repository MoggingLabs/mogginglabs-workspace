/** Stable identifier for a terminal pane within a workspace. */
export type PaneId = number

/** Everything needed to (re)create a pane's hosted process. */
export interface PaneSpec {
  id: PaneId
  cwd: string
  cols: number
  rows: number
}

/** The minimum a caller must know about a workspace to locate a pane in it. The
 *  renderer's live snapshot (`WorkspaceInfo`) and main's persisted metadata
 *  (`WorkspaceStateMeta`) both satisfy this shape — that is the point: ONE
 *  resolver, so the two sides can never disagree about where a pane lives. */
export interface PaneHost {
  id: string
  ordinal: number
  /** Per-slot pane id for slots that do NOT follow `ordinal * 100 + slot` —
   *  a pane MOVED here from another workspace keeps its own id (that id is its
   *  daemon session key). Sparse; absent on workspaces that never received one. */
  paneIds?: (number | null)[]
}

/**
 * Which workspace holds this pane, and in which SLOT (1-based).
 *
 * `ordinal * 100 + slot` is where a pane is BORN, and for almost every pane it is
 * still true. It stops being true the moment a pane moves to another workspace: the
 * pane keeps its id, so the formula would keep naming the workspace it LEFT. A
 * workspace that has taken one in says so explicitly in `paneIds`, and an explicit
 * claim always outranks the formula's guess. Main-side callers resolving a pane's
 * workspace for CONSENT or GRANTS must use this — the formula alone hands a moved
 * pane its birth workspace's permissions.
 */
export function locatePaneWorkspace<W extends PaneHost>(
  workspaces: readonly W[],
  paneId: number
): { workspace: W; slot: number } | undefined {
  if (!Number.isInteger(paneId) || paneId <= 0) return undefined
  for (const ws of workspaces) {
    const slot = ws.paneIds?.findIndex((id) => id === paneId) ?? -1
    if (slot >= 0) return { workspace: ws, slot: slot + 1 }
  }
  const ordinal = Math.floor(paneId / 100)
  const slot = paneId - ordinal * 100
  if (slot < 1) return undefined
  const ws = workspaces.find((w) => w.ordinal === ordinal)
  // ...but a slot that has been RE-let to a pane from elsewhere cannot also still be
  // answering for the one that moved out. That pane lives in whichever workspace
  // claimed it above; if none did, it is simply gone.
  if (!ws || (ws.paneIds?.[slot - 1] != null && ws.paneIds[slot - 1] !== paneId)) return undefined
  return { workspace: ws, slot }
}
