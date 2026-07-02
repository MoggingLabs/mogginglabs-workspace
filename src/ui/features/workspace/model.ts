/**
 * A workspace tab = a project directory + its pane layout. Persisted as pure METADATA
 * (no secrets, no credentials — ADR 0002). The `ordinal` is a stable index that maps to the
 * base pane id (`ordinal * 100`), so a workspace's pane ids survive a restart and re-attach
 * to the daemon's restored panes.
 */
export interface WorkspaceMeta {
  id: string
  name: string
  color: string
  cwd: string
  ordinal: number
  paneCount: number
  assignments?: string[] // per-slot provider (06b template lineup)
  paneCwds?: (string | null)[] // per-slot cwd override (worktree isolation, Phase-3/03)
  roles?: (string | null)[] // per-slot swarm role (Phase-4/01)
  remotes?: ({ hostId: string; name: string } | null)[] // per-slot remote host (Phase-4/05)
}

/**
 * Per-workspace accent colors, assigned round-robin by ordinal. Curated to hold AA on
 * dark surfaces, harmonize with the brand orange, and stay hue-distinct at a glance.
 * Brand orange is deliberately LAST: the *current* workspace is always marked by the
 * brand-orange outline, so early workspaces keep their icon accent separable from it.
 */
export const WORKSPACE_COLORS = [
  '#2dd4bf', // teal
  '#a78bfa', // violet
  '#38bdf8', // sky
  '#fb7185', // rose
  '#a3e635', // lime
  '#e879f9', // magenta
  '#fbbf24', // amber
  '#fd8d03' // brand orange
]

export function colorForOrdinal(ordinal: number): string {
  return WORKSPACE_COLORS[ordinal % WORKSPACE_COLORS.length]
}

/** Unique id for a new workspace (renderer is a secure context, so randomUUID exists). */
export function newWorkspaceId(): string {
  const c = globalThis.crypto
  return c && 'randomUUID' in c ? c.randomUUID() : `ws-${Date.now().toString(36)}`
}
