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

// ── File-level status (Phase-11/05) ──────────────────────────────────────────
// The explorer's decorations. These are the porcelain-v2 lines the branch probe ALREADY
// reads every 2.5s and throws away after setting `dirty` — so they ride the SAME spawn on
// the SAME shared tick. No second cadence exists, and none may be added.

/** `renamed` is carried faithfully; the tree RENDERS it as M (a rename is a modification
 *  you can see the shape of, and a sixth letter buys nothing at 10px). */
export type GitFileStatus = 'modified' | 'added' | 'untracked' | 'deleted' | 'conflicted' | 'renamed'

export interface GitFileState {
  /** REPO-RELATIVE, forward-slashed — git's own spelling. The renderer joins it onto the
   *  root it was handed; no OS path arithmetic crosses this wire. */
  path: string
  state: GitFileStatus
}

/** Sorted, THEN capped — so truncation is deterministic. A tree with more changed paths
 *  than this is a `git checkout` in flight, not a review surface. */
export const GIT_FILES_CAP = 2000

export interface GitFiles {
  /** Absolute repo root. Every `path` above is relative to THIS. */
  root: string
  files: GitFileState[]
  truncated: boolean
}

/** backend -> UI: a REGISTERED root's file list changed. Change-only: an idle repo — even
 *  one being polled every 2.5s — sends nothing at all. */
export type GitFilesEvent = GitFiles

/** UI -> backend: which of these paths does git ignore? ONE `check-ignore --stdin` batch
 *  per call (the probe's spawn discipline); the caller caches and invalidates. We never
 *  parse `.gitignore` ourselves — git owns that grammar, negations and all. */
export interface GitCheckIgnoreRequest {
  root: string
  /** Repo-relative, forward-slashed. Echoed back for the ignored subset. */
  paths: string[]
}
