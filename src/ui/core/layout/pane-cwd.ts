import type { PaneId } from '@contracts'

/**
 * Per-pane current working directory. WRITERS: the `workspace` feature seeds each pane with its
 * workspace cwd (the reliable default — panes cd there when an agent launches, and shells like
 * cmd.exe never emit OSC 7), and `terminal` refines it live from OSC 7 as the shell/agent cds
 * around. READER: the `git` feature, which probes the cwd for branch + dirty. A port so none of
 * these features import one another — they meet only here + `@contracts`.
 *
 * `null` in a subscriber callback means the pane's cwd was cleared (the pane was disposed).
 */
const cwds = new Map<PaneId, string>()
const subscribers = new Set<(paneId: PaneId, cwd: string | null) => void>()

export function setPaneCwd(paneId: PaneId, cwd: string): void {
  if (!cwd || cwds.get(paneId) === cwd) return // ignore empty + no-op churn
  cwds.set(paneId, cwd)
  for (const cb of subscribers) cb(paneId, cwd)
}

export function clearPaneCwd(paneId: PaneId): void {
  if (!cwds.delete(paneId)) return
  for (const cb of subscribers) cb(paneId, null)
}

export function getPaneCwd(paneId: PaneId): string | undefined {
  return cwds.get(paneId)
}

/** Subscribe to cwd changes. Current values are replayed immediately (order-independent). */
export function onPaneCwd(cb: (paneId: PaneId, cwd: string | null) => void): () => void {
  subscribers.add(cb)
  for (const [id, cwd] of cwds) cb(id, cwd)
  return () => subscribers.delete(cb)
}
