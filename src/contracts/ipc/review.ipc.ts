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

export interface ReviewDiff {
  /** The branch the worktree forked from (merge target). */
  base: string
  /** The worktree's branch. */
  branch: string
  files: ReviewFile[]
  /** Files present but not yet tracked by git (names only). */
  untracked: string[]
  /** True when the patch exceeded the transport cap and hunks were truncated. */
  truncated: boolean
  /** How many secret-pattern hits were scrubbed (a COUNT — never the content). */
  redactions: number
  /** Reviewer gate (4/03): does this branch hold a live sign-off? */
  approved?: boolean
  error?: string
}

export interface ReviewMergeRequest {
  repo: string
  branch: string
  /** Human override for an unapproved branch: must be the word 'override' VERBATIM
   *  (typed in the modal). Anything else leaves the gate closed. */
  override?: string
}

export interface ReviewMergeResult {
  ok: boolean
  /** merged | conflict (left in progress for a human terminal) | dirty (repo not
   *  clean — refused) | ungated (no reviewer sign-off + no typed override, 4/03) |
   *  error. Never auto-resolved. */
  state: 'merged' | 'conflict' | 'dirty' | 'ungated' | 'error'
  error?: string
}
