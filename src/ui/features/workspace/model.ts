/**
 * A workspace tab = a project directory + its pane layout. Persisted as pure METADATA
 * (no secrets, no credentials — ADR 0002). The `ordinal` is a stable index that maps to the
 * base pane id (`ordinal * 100`), so a workspace's pane ids survive a restart and re-attach
 * to the daemon's restored panes.
 *
 * That formula is the DEFAULT, not the law: a pane MOVED here from another workspace keeps
 * its own id, and `paneIds` records it. It has to keep it — a pane's id is its daemon
 * session key, and re-keying it would mean killing the PTY and spawning a new one, which is
 * not a move but a re-creation with the running agent destroyed.
 */
export interface WorkspaceMeta {
  id: string
  name: string
  color: string
  cwd: string
  ordinal: number
  paneCount: number
  assignments?: string[] // per-slot provider (06b template lineup)
  paneCwds?: (string | null)[] // per-slot restore/relaunch cwd (isolated or explicitly reported worktree)
  roles?: (string | null)[] // per-slot swarm role (Phase-4/01)
  remotes?: ({ hostId: string; name: string; cwd?: string } | null)[] // per-slot remote host + remote cwd (Phase-4/05)
  profileIds?: (string | null)[] // per-slot launch profile (4/04 picker; persisted 6/04 — restore + failover keep it true)
  /** Per-slot pane id, for slots that do NOT follow `ordinal * 100 + slot` — i.e. panes
   *  that moved here from another workspace. Sparse; absent on any workspace that has
   *  never received one, so untouched workspaces persist exactly as they always did. */
  paneIds?: (number | null)[]
  layout?: string | null // serialized split-tree (shape + sizes); absent/invalid → template grid
}

/** The pane id a workspace's local slot hosts (slots are 1-based). The formula, unless the
 *  slot holds a pane that moved here — those keep their own id, which is the whole point.
 *  Used on the paths that must resolve an id BEFORE the grid exists (a pane reads its cwd,
 *  remote and role seeds at spawn time). */
export function paneIdForSlot(meta: WorkspaceMeta, slot: number): number {
  const moved = meta.paneIds?.[slot - 1]
  return typeof moved === 'number' && moved >= 1 ? moved : meta.ordinal * 100 + slot
}

/**
 * Per-workspace accent colors, assigned round-robin by ordinal. Recalibrated in
 * Phase-5/01 (measured, not eyeballed — table in docs/11-design-system.md): every
 * color holds ≥7:1 on the dark app background as-is, and ≥4.5:1 on white through the
 * light theme's `--ws-ink` ramp stop (color-mix 54% toward black). Hues are spread so
 * ADJACENT ordinals never collide (min gap ≈49°; the old amber sat 12° from brand).
 * Brand orange is deliberately LAST: brand orange always means "needs you" (the
 * `.ws-attn` attention badge), so early workspaces keep their accent separable from it.
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
