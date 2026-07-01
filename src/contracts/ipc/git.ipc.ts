// Per-pane git contract (Phase-2/03). Strictly READ-ONLY: the backend probes a pane's cwd for
// its branch + dirty state and streams changes; no command on this wire ever mutates a repo.
// No credentials or file CONTENT cross this boundary — only a cwd (in) and a small status (out).

import type { PaneId } from '../domain/pane'

/** Read-only git status for a pane's cwd. `null` on the wire when the cwd is not inside a repo. */
export interface GitStatus {
  /** Absolute repo root (the dir containing `.git`). */
  root: string
  /** Current branch name, or a short SHA when HEAD is detached. */
  branch: string
  /** HEAD is detached (no branch); `branch` is then a short SHA. */
  detached: boolean
  /** Commits ahead of the upstream (0 when no upstream). */
  ahead: number
  /** Commits behind the upstream (0 when no upstream). */
  behind: number
  /** Working tree has uncommitted changes (staged, unstaged, or untracked). */
  dirty: boolean
}

/** UI -> backend: begin tracking a pane's cwd; `git:change` events follow as it changes. */
export interface GitWatchRequest {
  paneId: PaneId
  cwd: string
}

/** UI -> backend: stop tracking a pane (e.g. the pane was disposed). */
export interface GitUnwatchRequest {
  paneId: PaneId
}

/** backend -> UI: a pane's git status resolved or changed (`status` null = not a repo). */
export interface GitStatusEvent {
  paneId: PaneId
  status: GitStatus | null
}
