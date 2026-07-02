import { ipcMain } from 'electron'
import { diffWorktree, mergeBranch } from '@backend/features/review'
import { isManaged } from '@backend/features/worktrees'
import {
  ReviewChannels,
  type ReviewDiffRequest,
  type ReviewMergeRequest
} from '@contracts'

// App-wiring: bind the review module (Phase-3/04) to IPC. Diffs are redacted INSIDE
// @backend before they reach this layer; nothing here logs, persists, or forwards
// diff content anywhere but the requesting renderer. The worktree must be one WE
// manage (same containment guard as removal); merge is branch-name-validated in the
// backend and clean-repo gated.
export function registerReview(): void {
  ipcMain.handle(ReviewChannels.diff, (_e, req: ReviewDiffRequest) => {
    if (typeof req?.repo !== 'string' || typeof req?.worktree !== 'string' || !req.repo || !req.worktree) {
      return { base: '', branch: '', files: [], untracked: [], truncated: false, redactions: 0, error: 'bad request' }
    }
    if (!isManaged(req.repo, req.worktree)) {
      return { base: '', branch: '', files: [], untracked: [], truncated: false, redactions: 0, error: 'not a managed worktree' }
    }
    return diffWorktree(req.repo, req.worktree)
  })
  ipcMain.handle(ReviewChannels.merge, (_e, req: ReviewMergeRequest) =>
    typeof req?.repo === 'string' && typeof req?.branch === 'string' && req.repo && req.branch
      ? mergeBranch(req.repo, req.branch)
      : { ok: false, state: 'error', error: 'bad request' }
  )
}
