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
 * The identity colors, in ALLOCATION order. Measured, not eyeballed (table in
 * docs/11-design-system.md): every color holds ≥7:1 on the dark app background as-is,
 * and ≥4.5:1 on white through the light theme's `--ws-ink` ramp stop (color-mix 54%
 * toward black). Brand orange is deliberately last of the original eight: brand orange
 * always means "needs you" (the `.ws-attn` badge), so early workspaces keep their accent
 * separable from it.
 *
 * Twelve, not eight (Phase-11). The palette is what `nextColor` draws from, so its SIZE
 * is the number of workspaces that can be open at once and all look different — eight was
 * that ceiling, and the rail hit it. The four additions were placed in the four widest
 * gaps of the existing hue wheel and hold the same 22.4° minimum separation the original
 * eight already had between lime and green; going further (16) could only be bought by
 * halving that, and the new hues landed on top of brand orange, which is spoken for.
 * Twelve is where the wheel stops paying.
 */
export const WORKSPACE_COLORS = [
  '#2dd4bf', // teal
  '#a78bfa', // violet
  '#38bdf8', // sky
  '#fb7185', // rose
  '#9bdf2f', // lime
  '#e879f9', // magenta
  '#4ade80', // green (replaced amber — 12° from brand, indistinguishable at a glance)
  '#fd8d03', // brand orange
  '#1fdef2', // cyan
  '#71a0fe', // cornflower
  '#e2c456', // yellow
  '#ff99cf' // pink
]

/**
 * The color a NEW workspace takes: the first one no LIVE workspace is wearing.
 *
 * This used to be `WORKSPACE_COLORS[ordinal % 8]`, and that is a promise the ordinal
 * cannot keep. Ordinals are pane-id anchors, so they only ever climb (`nextOrdinal =
 * max(next, ordinal + 1)`) and are never recycled — close a few workspaces, open a few
 * more, and the counter walks past 8 and starts handing out colors that are already on
 * screen. It does not take nine workspaces to see it: ordinals 0 and 8 are both teal, so
 * TWO open workspaces are enough. A real store had brand orange twice.
 *
 * Allocating against the live set instead makes a collision unrepresentable while the
 * palette holds. Past twelve there is no honest answer left — reuse is forced — so spread
 * it: hand back the LEAST-worn color rather than piling every overflow onto the same hue.
 */
export function nextColor(taken: Iterable<string>): string {
  const worn = new Map<string, number>()
  for (const c of taken) {
    const key = c.toLowerCase()
    worn.set(key, (worn.get(key) ?? 0) + 1)
  }
  const free = WORKSPACE_COLORS.find((c) => !worn.has(c))
  if (free) return free
  return WORKSPACE_COLORS.reduce((best, c) => ((worn.get(c) ?? 0) < (worn.get(best) ?? 0) ? c : best))
}

/** Is this one of ours? Guards the RESTORE path: states written before this palette carry
 *  retired hexes (the pre-01 lime `#b5d21b`), and a workspace may not keep a color the
 *  app no longer owns. */
export function isWorkspaceColor(color: string | undefined): boolean {
  return !!color && WORKSPACE_COLORS.includes(color.toLowerCase())
}

/**
 * Settle the colors for a WHOLE restored set at once, in persisted order.
 *
 * Two passes, and the order is the point. Workspaces with a good claim — one of ours, and
 * nobody ahead of them wearing it — are settled FIRST; only then is anything allocated.
 * One pass would let a workspace that has to be re-colored anyway (retired hex, or the
 * second of a duplicate pair) walk up and take a color that a later workspace legitimately
 * owns, evicting it — repairing one collision by causing another rename. On the real store
 * that is the difference between two workspaces changing color and one.
 *
 * A workspace with a valid, unclaimed color therefore ALWAYS keeps it. It wears it for
 * life; only the broken claims move.
 */
export function resolveColors(restored: (string | undefined)[]): string[] {
  const settled: (string | null)[] = restored.map(() => null)
  const taken: string[] = []

  restored.forEach((color, i) => {
    const want = color?.toLowerCase()
    if (want && isWorkspaceColor(want) && !taken.includes(want)) {
      settled[i] = want
      taken.push(want)
    }
  })
  settled.forEach((color, i) => {
    if (color) return
    const fresh = nextColor(taken)
    settled[i] = fresh
    taken.push(fresh)
  })
  return settled as string[]
}

/** Unique id for a new workspace (renderer is a secure context, so randomUUID exists). */
export function newWorkspaceId(): string {
  const c = globalThis.crypto
  return c && 'randomUUID' in c ? c.randomUUID() : `ws-${Date.now().toString(36)}`
}
