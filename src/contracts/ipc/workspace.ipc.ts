// Persistence contract (Phase-1/03). Shared types for the session/workspace store, which
// holds ONLY layout / cwd / command-label / scrollback — never provider credentials
// (ADR 0002). Workspace/layout IPC *channels* arrive with steps 04/05 that build those
// features; for now this is the persisted-shape contract shared by the store and its callers.

export interface PersistedPane {
  id: string
  workspaceId?: string // which workspace this pane belongs to (default: "default")
  cwd: string
  /** Last explicit agent context, stored separately from the shell's requested launch cwd. */
  reportedCwd?: string
  reportedCwdAt?: number
  /** SSH connection pointer only; required to restore a remote pane as remote. Carries the
   *  platform AND the shell dialect: a restored pane must come back speaking the same language
   *  it went away in, or the first command typed at it is a bash-ism at a PowerShell. */
  remote?: {
    name: string
    host: string
    user?: string
    port?: number
    cwd?: string
    platform?: 'posix' | 'windows'
    shell?: 'sh' | 'bash' | 'zsh' | 'powershell' | 'cmd'
  }
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
  /** Serialized split-tree layout (v1 JSON: shape + sizes, leaf ids 1..paneCount).
   *  Geometry only — never content. Absent/invalid → the template grid for paneCount. */
  layout?: string | null
  assignments?: string[] // per-slot provider (06b template lineup); undefined = plain shells
  /** Per-slot cwd override (worktree isolation or an explicit agent cwd report) —
   *  restored workspaces re-attach/relaunch panes in their worktrees. Paths only. */
  paneCwds?: (string | null)[]
  /** Per-slot swarm role (Phase-4/01) — the manifest survives restore. */
  roles?: (string | null)[]
  /** Per-slot remote host (Phase-4/05) — pointers + display name only. */
  remotes?: ({ hostId: string; name: string; cwd?: string } | null)[]
  /** Per-slot launch profile (Phase-6/04) — profile IDS only, never env values
   *  (those stay main-side; ADR 0002). Restored lineups relaunch under the
   *  chosen profile; failover rewrites the slot it switched. */
  profileIds?: (string | null)[]
  /** Per-slot pane id, for the slots that do NOT follow `ordinal * 100 + slot`: a pane
   *  MOVED here from another workspace keeps its own id, because that id is its daemon
   *  session key. Restoring it under this workspace's formula would spawn a fresh shell
   *  and orphan the live one. Sparse, and absent entirely on any workspace that has never
   *  received a pane — their persisted shape is unchanged. Ids only (ADR 0002). */
  paneIds?: (number | null)[]
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

export interface WorkspaceSaveResult {
  ok: boolean
  reason?: string
}

export interface WorkspaceExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  reason?: string
}
