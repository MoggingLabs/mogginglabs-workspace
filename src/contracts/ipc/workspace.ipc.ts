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

// --- App-level workspace state (Phase-1/05: tabs + theme) ------------------------------
// Persisted by the app layer (main) so tabs/themes restore on relaunch. Metadata ONLY —
// name/color/cwd/ordinal/paneCount + the theme id. NEVER credentials (ADR 0002).

/** One workspace tab's persisted metadata. `ordinal` maps to its base pane id. */
export interface WorkspaceStateMeta {
  id: string
  name: string
  color: string
  cwd: string
  ordinal: number
  paneCount: number
  assignments?: string[] // per-slot provider (06b template lineup); undefined = plain shells
}

/** A recently-worked-on project (directory) for Home's one-click reopen tiles —
 *  touched whenever a workspace opens or closes for that folder. Metadata only —
 *  a folder + layout + provider lineup, never credentials (ADR 0002). */
export interface RecentWorkspace {
  name: string
  cwd: string
  paneCount: number
  assignments?: string[]
  /** Last time this project was opened/worked on (epoch ms). */
  lastUsedAt: number
}

/** Full app-level workspace state persisted across relaunch. */
export interface WorkspaceState {
  workspaces: WorkspaceStateMeta[]
  activeId: string | null
  theme: string
  /** Recently-worked-on projects, newest first (capped by the writer). */
  recents?: RecentWorkspace[]
}
