import { ipcMain } from 'electron'
import { diffWorktree, mergeBranch } from '@backend/features/review'
import { isManaged } from '@backend/features/worktrees'
import { getDaemonClient } from './daemon-relay'
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
    return (async () => {
      const diff = await diffWorktree(req.repo, req.worktree)
      // Reviewer gate (4/03): surface the live sign-off state with the diff. Fail
      // CLOSED — no daemon means no approvals.
      const approvals = (await getDaemonClient()?.queryApprovals()) ?? []
      return { ...diff, approved: approvals.some((a) => a.branch === diff.branch) }
    })()
  })
  ipcMain.handle(ReviewChannels.merge, (_e, req: ReviewMergeRequest) => {
    if (typeof req?.repo !== 'string' || typeof req?.branch !== 'string' || !req.repo || !req.branch) {
      return { ok: false, state: 'error', error: 'bad request' }
    }
    return (async () => {
      // Gate consultation happens HERE in main — the renderer's payload can carry the
      // typed override word, but never an approval claim. Fail closed without a daemon.
      const approvals = (await getDaemonClient()?.queryApprovals()) ?? []
      const approved = approvals.some((a) => a.branch === req.branch)
      return mergeBranch(req.repo, req.branch, {
        approved,
        override: typeof req.override === 'string' ? req.override : undefined
      })
    })()
  })
}
