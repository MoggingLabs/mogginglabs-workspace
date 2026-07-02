// Worktree-per-agent isolation (Phase-3/03). Parallel agents on ONE repo trample each
// other; each isolated agent pane gets its own git worktree (own branch, own working
// dir) under <repo>/.mogging/worktrees/. Payloads carry paths + branch names only —
// never task text, file content, or credentials (ADR 0002); slugs are random.

export interface WorktreeInfo {
  path: string
  branch: string
  dirty: boolean
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
