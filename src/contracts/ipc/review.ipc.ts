// Pre-ship diff review (Phase-3/04). NOTHING an agent wrote lands without a human
// reading it: the diff arrives REDACTED (secrets scrubbed backend-side) and is
// rendered as text nodes only. Diff content never enters telemetry, logs, or
// persisted state. The single mutating verb is a guarded merge.

export interface ReviewDiffRequest {
  repo: string
  worktree: string
}

export interface ReviewFile {
  path: string
  additions: number
  deletions: number
  /** Unified-diff hunks (text, already redacted). Rendered via textContent ONLY. */
  hunks: string[]
}

/** Exact Git object graph a human reviewed. Paths are never sufficient: branch names
 *  move, and the same name exists in many repositories. */
export interface ReviewSnapshot {
  /** Canonical git-common-dir identity (normalized absolute path). */
  repoId: string
  branch: string
  /** Exact source commit reviewed. */
  head: string
  /** Named destination branch recorded for the worktree. */
  base: string
  /** Exact destination commit the review was based on. */
  baseHead: string
  /** Merge base used to build the displayed patch. */
  mergeBase: string
}

export interface ReviewDiff {
  /** The branch the worktree forked from (merge target). */
  base: string
  /** The worktree's branch. */
  branch: string
  /** Exact object identities behind this rendered diff. Missing only on read failure. */
  snapshot?: ReviewSnapshot
  files: ReviewFile[]
  /** Files present but not yet tracked by git (names only). */
  untracked: string[]
  /** True when the patch exceeded the transport cap and hunks were truncated. */
  truncated: boolean
  /** Worktree contains staged, unstaged, or untracked changes not represented by `head`. */
  dirty: boolean
  /** Binary/mode-only/otherwise non-rendered changes exist. */
  unreviewable: boolean
  /** How many secret-pattern hits were scrubbed (a COUNT — never the content). */
  redactions: number
  /** Reviewer gate (4/03): does this branch hold a live sign-off? */
  approved?: boolean
  error?: string
}

export interface ReviewMergeRequest {
  repo: string
  /** Managed worktree is re-read in main immediately before merge; renderer claims are ignored. */
  worktree: string
  /** Human override for an unapproved branch: must be the word 'override' VERBATIM
   *  (typed in the modal). Anything else leaves the gate closed. */
  override?: string
}

export interface ReviewMergeResult {
  ok: boolean
  /** merged | conflict (left in progress for a human terminal) | dirty (repo not
   *  clean — refused) | ungated (no reviewer sign-off + no typed override, 4/03) |
   *  unreviewable (dirty/truncated/non-renderable source) | stale (source/base/repo changed) |
   *  error. Never auto-resolved. */
  state: 'merged' | 'conflict' | 'dirty' | 'ungated' | 'unreviewable' | 'stale' | 'error'
  error?: string
}
