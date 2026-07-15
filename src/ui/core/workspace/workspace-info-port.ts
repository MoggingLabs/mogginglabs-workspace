// Read-only mirror of the workspace list + which one is active, published by the
// workspace feature after every mutation. Lets Home / the palette / notify toasts
// reason about workspaces (and ask for a switch) without importing the feature.

export interface WorkspaceInfo {
  id: string
  name: string
  color: string
  cwd: string
  ordinal: number
  paneCount: number
  /** Per-slot provider assignment; used only to scope launch-time pane capabilities. */
  assignments?: string[]
  /** Per-slot pane id, for the slots that do NOT follow `ordinal * 100 + slot` — panes
   *  that were MOVED here from another workspace keep their own id. Absent on a workspace
   *  that has never received one, which is nearly all of them. */
  paneIds?: (number | null)[]
}

export interface WorkspacesSnapshot {
  workspaces: WorkspaceInfo[]
  activeId: string | null
}

type Listener = (snapshot: WorkspacesSnapshot) => void

let snapshot: WorkspacesSnapshot = { workspaces: [], activeId: null }
const listeners = new Set<Listener>()
let switcher: ((id: string) => void) | null = null

export function publishWorkspaces(next: WorkspacesSnapshot): void {
  snapshot = next
  for (const cb of listeners) cb(snapshot)
}

export function getWorkspaces(): WorkspacesSnapshot {
  return snapshot
}

/**
 * Which workspace holds this pane, and in which SLOT (1-based).
 *
 * `ordinal * 100 + slot` is where a pane is BORN, and for almost every pane it is still
 * true. It stops being true the moment a pane moves to another workspace: the pane keeps
 * its id (that id is its daemon session — see WorkspaceMeta.paneIds), so the formula would
 * keep naming the workspace it LEFT. A workspace that has taken one in says so explicitly
 * in `paneIds`, and an explicit claim always outranks the formula's guess.
 */
function locate(paneId: number): { ws: WorkspaceInfo; slot: number } | undefined {
  for (const ws of snapshot.workspaces) {
    const slot = ws.paneIds?.findIndex((id) => id === paneId) ?? -1
    if (slot >= 0) return { ws, slot: slot + 1 }
  }
  const ordinal = Math.floor(paneId / 100)
  const slot = paneId - ordinal * 100
  if (slot < 1) return undefined
  const ws = snapshot.workspaces.find((w) => w.ordinal === ordinal)
  // ...but a slot that has been RE-let to a pane from elsewhere cannot also still be
  // answering for the one that moved out. That pane lives in whichever workspace claimed
  // it above; if none did, it is simply gone.
  if (!ws || (ws.paneIds?.[slot - 1] != null && ws.paneIds[slot - 1] !== paneId)) return undefined
  return { ws, slot }
}

/** The workspace a pane belongs to. Used to materialize the right tool plan at launch
 *  (Phase-8/09), and to route a pane's notifications to the tab that actually holds it. */
export function workspaceIdForPane(paneId: number): string | undefined {
  return locate(paneId)?.ws.id
}

/** The provider assigned to this exact slot, or undefined for a plain/unassigned shell. */
export function assignmentForPane(paneId: number): string | undefined {
  const found = locate(paneId)
  return found?.ws.assignments?.[found.slot - 1]
}

/** Subscribe (replays the current snapshot immediately). Returns unsubscribe. */
export function onWorkspacesChange(cb: Listener): () => void {
  listeners.add(cb)
  cb(snapshot)
  return () => listeners.delete(cb)
}

/** The workspace feature registers the one real switcher. */
export function setWorkspaceSwitcher(fn: (id: string) => void): void {
  switcher = fn
}

export function requestWorkspaceSwitch(id: string): void {
  switcher?.(id)
}
