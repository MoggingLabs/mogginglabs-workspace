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
  profileIds?: (string | null)[] // per-slot launch profile (4/04 picker; persisted 6/04 — restore + failover keep it true)
}

/**
 * Per-workspace accent colors, assigned round-robin by ordinal. Recalibrated in
 * Phase-5/01 (measured, not eyeballed — table in docs/11-design-system.md): every
 * color holds ≥7:1 on the dark app background as-is, and ≥4.5:1 on white through the
 * light theme's `--ws-ink` ramp stop (color-mix 54% toward black). Hues are spread so
 * ADJACENT ordinals never collide (min gap ≈49°; the old amber sat 12° from brand).
 * Brand orange is deliberately LAST: the *current* workspace is always marked by the
 * brand-orange outline, so early workspaces keep their icon accent separable from it.
 */
export const WORKSPACE_COLORS = [
  '#2dd4bf', // teal
  '#a78bfa', // violet
  '#38bdf8', // sky
  '#fb7185', // rose
  '#9bdf2f', // lime
  '#e879f9', // magenta
  '#4ade80', // green (replaced amber — 12° from brand, indistinguishable at a glance)
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
