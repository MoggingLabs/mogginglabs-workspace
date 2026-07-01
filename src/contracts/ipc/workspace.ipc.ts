// Persistence contract (Phase-1/03). Shared types for the session/workspace store, which
// holds ONLY layout / cwd / command-label / scrollback — never provider credentials
// (ADR 0002). Workspace/layout IPC *channels* arrive with steps 04/05 that build those
// features; for now this is the persisted-shape contract shared by the store and its callers.

export interface PersistedPane {
  id: string
  workspaceId?: string // which workspace this pane belongs to (default: "default")
  cwd: string
  command?: string // launch label (e.g. "claude") — NEVER a credential
  scrollback: string // raw PTY output for repaint (local terminal content)
  updatedAt: number
}

/** Pane arrangement within a workspace. Flat list for now; steps 04/05 extend it to a
 *  split tree. Serialized into `PersistedWorkspace.layout`. */
export interface WorkspaceLayout {
  v: number
  panes: string[] // pane ids, in arrangement order
}

export interface PersistedWorkspace {
  id: string
  name?: string
  layout?: string // JSON-serialized WorkspaceLayout
  updatedAt: number
}
