// Worktree-per-agent isolation (Phase-3/03). Parallel agents on ONE repo trample each
// other; each isolated agent pane gets its own git worktree (own branch, own working
// dir) under <repo>/.mogging/worktrees/. Payloads carry paths + branch names only —
// never task text, file content, or credentials (ADR 0002); slugs are random.

export interface WorktreeInfo {
  path: string
  branch: string
  dirty: boolean
}

/**
 * Can this folder actually be isolated, RIGHT NOW? Asked before the wizard offers the
 * toggle, because the alternative shipped and was miserable: `probeGit` degrades to
 * reading `.git/HEAD` when git cannot be run at all, the wizard read "is a repo" off
 * that, and the checkbox enabled itself on a machine where every `git worktree add` was
 * guaranteed to fail. The user ticked a box that could not work and found out at Launch.
 *
 * Each `blocked` reason names something the user can act on, and only the LAST one is a
 * dead end without a fix button.
 */
export type WorktreePreflightReason =
  | 'ok'
  /** `git` is not resolvable by the app — usually installed after the app started. */
  | 'no-git'
  /** Not a git repository. */
  | 'not-a-repo'
  /** A repository with no commits: `git worktree add` has no HEAD to fork from. */
  | 'no-commits'
  /** `<repo>/.mogging` could not be created — permissions, or a read-only volume. */
  | 'not-writable'
  /** Git ran and refused for a reason we did not model; `detail` carries its own words. */
  | 'unsupported'

export interface WorktreePreflight {
  ok: boolean
  reason: WorktreePreflightReason
  /** Git's own message, when it had one. Shown verbatim — never paraphrased away. */
  detail?: string
}

export interface CreateWorktreeRequest {
  repo: string
}

export interface CreateWorktreeResult {
  ok: boolean
  path?: string
  branch?: string
  error?: string
}

export interface RemoveWorktreeRequest {
  repo: string
  path: string
  /** Remove even when the worktree has uncommitted changes. Default FALSE — dirty
   *  worktrees are refused (reason: 'dirty') until explicitly forced. */
  force?: boolean
}

export interface RemoveWorktreeResult {
  ok: boolean
  reason?: 'dirty' | 'not-managed' | 'error'
  error?: string
}
