import { ipcMain } from 'electron'
import { diffWorktree, mergeBranch } from '@backend/features/review'
import { isManaged } from '@backend/features/worktrees'
import { captureMerge } from './brain-capture'
import { maybeFault } from './fault-port'
import { getAuthoritativeApprovals } from './daemon-relay'
import {
  ReviewChannels,
  type Approval,
  type ReviewDiffRequest,
  type ReviewMergeRequest,
  type ReviewSnapshot
} from '@contracts'

export function approvalMatchesSnapshot(approval: Approval, snapshot: ReviewSnapshot): boolean {
  const a = approval.snapshot
  return (
    approval.repoId === snapshot.repoId &&
    approval.branch === snapshot.branch &&
    a.repoId === snapshot.repoId &&
    a.branch === snapshot.branch &&
    a.head === snapshot.head &&
    a.base === snapshot.base &&
    a.baseHead === snapshot.baseHead &&
    a.mergeBase === snapshot.mergeBase
  )
}

const badDiff = (error: string) => ({
  base: '', branch: '', files: [], untracked: [], truncated: false,
  dirty: false, unreviewable: true, redactions: 0, error
})

/** Re-read and merge one managed worktree against an explicit approval set. Exported so the
 *  snapshot regression gate exercises the same decision path as IPC. */
export async function mergeReviewedWorktree(
  req: ReviewMergeRequest,
  approvals: readonly Approval[]
) {
  if (typeof req?.repo !== 'string' || typeof req?.worktree !== 'string' || !req.repo || !req.worktree) {
    return { ok: false, state: 'error' as const, error: 'bad request' }
  }
  if (!isManaged(req.repo, req.worktree)) {
    return { ok: false, state: 'error' as const, error: 'not a managed worktree' }
  }
  const diff = await diffWorktree(req.repo, req.worktree)
  if (diff.error || !diff.snapshot) {
    return { ok: false, state: 'error' as const, error: diff.error ?? 'snapshot unavailable' }
  }
  if (diff.dirty || diff.truncated || diff.unreviewable || diff.untracked.length) {
    return {
      ok: false,
      state: 'unreviewable' as const,
      error: 'commit or remove every working-tree change and review the complete renderable diff first'
    }
  }
  const approved = approvals.some((a) => approvalMatchesSnapshot(a, diff.snapshot!))
  const result = await mergeBranch(req.repo, diff.snapshot, {
    approved,
    override: typeof req.override === 'string' ? req.override : undefined
  })
  if (result.ok && result.state === 'merged') {
    // ADR 0018 revision C: a landed merge is a capture SIGNAL — the branch,
    // the reviewed diff's files, the graph's symbols in them. Fire-and-forget:
    // capture is evidence, never enforcement, and the merge reply never waits.
    void captureMerge(req.repo, diff.snapshot.branch, diff.files.map((f) => f.path)).catch(() => undefined)
  }
  return result
}

// App-wiring: bind the review module (Phase-3/04) to IPC. Diffs are redacted INSIDE
// @backend before they reach this layer; nothing here logs, persists, or forwards
// diff content anywhere but the requesting renderer. The worktree must be one WE
// manage (same containment guard as removal); merge is branch-name-validated in the
// backend and clean-repo gated.
export function registerReview(): void {
  ipcMain.handle(ReviewChannels.diff, async (_e, req: ReviewDiffRequest) => {
    // Finding 39's seam: the review modal's ONE read. Reject it and the UI must say so out loud;
    // hang it and the "Reading the diff…" affordance must give up on its own.
    await maybeFault(ReviewChannels.diff)
    if (typeof req?.repo !== 'string' || typeof req?.worktree !== 'string' || !req.repo || !req.worktree) {
      return badDiff('bad request')
    }
    if (!isManaged(req.repo, req.worktree)) {
      return badDiff('not a managed worktree')
    }
    return (async () => {
      const diff = await diffWorktree(req.repo, req.worktree)
      // Reviewer gate (4/03): surface the live sign-off state with the diff. Fail
      // CLOSED — no daemon means no approvals. Only sign-offs from a pane the USER made a
      // reviewer count: the daemon's role map is open to any pane (see daemon-relay's
      // appRoles), so it can say "reviewer" about a pane that promoted itself.
      const approvals = await getAuthoritativeApprovals()
      const approved =
        !!diff.snapshot &&
        !diff.dirty &&
        !diff.unreviewable &&
        approvals.some((a) => approvalMatchesSnapshot(a, diff.snapshot!))
      return { ...diff, approved }
    })()
  })
  ipcMain.handle(ReviewChannels.merge, (_e, req: ReviewMergeRequest) => {
    return (async () => {
      // Gate consultation happens HERE in main — the renderer's payload can carry the
      // typed override word, but never an approval claim. Fail closed without a daemon.
      // THE authority check: an approval only counts if the app itself made its signer a
      // reviewer. Without this, `mogging role <self> reviewer` un-gated the merge, and an
      // agent could land its own unreviewed work with two CLI calls.
      const approvals = await getAuthoritativeApprovals()
      return mergeReviewedWorktree(req, approvals)
    })()
  })
}
