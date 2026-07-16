// Read-only mirror of the workspace list + which one is active, published by the
// workspace feature after every mutation. Lets Home / the palette / notify toasts
// reason about workspaces (and ask for a switch) without importing the feature.

import { locatePane } from '@contracts'

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
 * Which workspace holds this pane, and in which SLOT (1-based). The resolution — the
 * formula id, and the `paneIds` claims that outrank it for panes moved between
 * workspaces — is @contracts' locatePane, the SAME resolver main uses for grants and
 * browser routing, so the two sides can never again disagree about whose pane one is.
 */
function locate(paneId: number): { ws: WorkspaceInfo; slot: number } | undefined {
  return locatePane(snapshot.workspaces, paneId)
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
