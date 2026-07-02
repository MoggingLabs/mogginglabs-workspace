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
