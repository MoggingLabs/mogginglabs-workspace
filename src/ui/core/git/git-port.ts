import type { GitStatus, PaneId } from '@contracts'

/**
 * Per-pane git status. WRITER: the `git` feature (which probes each pane's cwd via the backend).
 * READER: each `TerminalPane`, which renders the branch + dirty chip in its corner badge — the
 * same port pattern the pane already uses for its agent label (pane-meta) and OSC state. A port
 * so `terminal` and `git` stay fully decoupled: terminal knows nothing about git IPC, git knows
 * nothing about the DOM. `null` = the pane is not in a repo (render no chip).
 */
const statuses = new Map<PaneId, GitStatus | null>()
const subscribers = new Set<(paneId: PaneId, status: GitStatus | null) => void>()

export function setPaneGit(paneId: PaneId, status: GitStatus | null): void {
  statuses.set(paneId, status)
  for (const cb of subscribers) cb(paneId, status)
}

export function clearPaneGit(paneId: PaneId): void {
  if (!statuses.delete(paneId)) return
  for (const cb of subscribers) cb(paneId, null)
}

export function getPaneGit(paneId: PaneId): GitStatus | null {
  return statuses.get(paneId) ?? null
}

/** Subscribe to git-status changes. Current values are replayed immediately. */
export function onPaneGit(cb: (paneId: PaneId, status: GitStatus | null) => void): () => void {
  subscribers.add(cb)
  for (const [id, status] of statuses) cb(id, status)
  return () => subscribers.delete(cb)
}
