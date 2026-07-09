import type { PaneId } from '@contracts'

/**
 * The currently-focused pane + ITS OWN cwd (the pane-cwd port's value — a worktree for an
 * isolated slot (3/03), OSC-7-refined — falling back to the workspace's cwd). Published by
 * the `workspace` feature; read by `agents` to launch a CLI into "the focused pane at the
 * right cwd" and by `review` to find the focused pane's worktree. The workspace ROOT here
 * broke both: a palette launch escaped the pane's worktree into the shared repo, and review
 * never saw a worktree at all. A port so neither feature imports the other.
 */
export interface FocusedPane {
  paneId: PaneId
  cwd: string
}

let current: FocusedPane | null = null
const subscribers = new Set<(f: FocusedPane | null) => void>()

export function setFocusedPane(focus: FocusedPane | null): void {
  current = focus
  for (const cb of subscribers) cb(current)
}

export function getFocusedPane(): FocusedPane | null {
  return current
}

export function onFocusedPane(cb: (f: FocusedPane | null) => void): () => void {
  subscribers.add(cb)
  cb(current)
  return () => subscribers.delete(cb)
}
