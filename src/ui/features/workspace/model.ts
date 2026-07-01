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
}

/** Tab accent colors, assigned round-robin by ordinal. */
export const WORKSPACE_COLORS = [
  '#4ade80',
  '#60a5fa',
  '#f472b6',
  '#fbbf24',
  '#a78bfa',
  '#f87171',
  '#34d399',
  '#fb923c'
]

export function colorForOrdinal(ordinal: number): string {
  return WORKSPACE_COLORS[ordinal % WORKSPACE_COLORS.length]
}

/** Unique id for a new workspace (renderer is a secure context, so randomUUID exists). */
export function newWorkspaceId(): string {
  const c = globalThis.crypto
  return c && 'randomUUID' in c ? c.randomUUID() : `ws-${Date.now().toString(36)}`
}
