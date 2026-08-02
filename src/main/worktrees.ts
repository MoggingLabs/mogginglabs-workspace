import { ipcMain } from 'electron'
import { normalizePaneCwd } from '@backend/features/agent-state'
import { createWorktree, listWorktrees, preflightWorktrees, removeWorktree } from '@backend/features/worktrees'
import {
  WorktreeChannels,
  type CreateWorktreeRequest,
  type RemoveWorktreeRequest
} from '@contracts'
import { basename } from 'node:path'
import { getDaemonClient } from './daemon-relay'
import { repoIdentity } from '@backend/features/review'
import { auditDelay, wizardAuditFaults } from './wizard-audit-faults'
import { worktreeAuditFault } from './worktree-audit-faults'

// App-wiring: bind the Electron-free worktree module (Phase-3/03) to IPC — the same
// shape as registerGit. Paths + branch names only; dirty-safe removal is enforced in
// the backend module, not here.
/**
 * A repo/worktree path from the renderer, or null.
 *
 * `typeof p === 'string' && p` was the whole check, and every one of these paths becomes
 * `git -C <path>` or an fs call. A relative path resolved against main's cwd (the install
 * directory in a packaged build), a control character rode into an argv, and a path that
 * simply no longer existed produced git's own error instead of ours.
 *
 * normalizePaneCwd is the normalizer nine other call sites already use for exactly this:
 * absolute, control-char-free, length-bounded, and a real directory. UNC is NOT refused
 * here — unlike a deep link, these arrive from the app's own renderer, and a repository on
 * a network share is an ordinary thing to have.
 */
const repoPath = (raw: unknown): string | null => normalizePaneCwd(raw, { mustExist: true })

export function registerWorktrees(): void {
  ipcMain.handle(WorktreeChannels.create, async (_e, req: CreateWorktreeRequest) => {
    const fault = wizardAuditFaults()
    if (fault) {
      // Each call's ORDINAL is captured at arrival: the wizard now issues its creates in
      // parallel, and comparing failAt against the live counter AFTER the delay failed
      // every call once the counter passed it (all concurrent calls saw the final count)
      // — the gate meant "the Nth create fails", not "every create from the Nth on".
      const call = ++fault.worktreeCreateCalls
      await auditDelay(fault.worktreeDelayMs)
      if (fault.worktreeFailAt === call) {
        return { ok: false, error: 'injected worktree creation failure' }
      }
    }
    const repo = repoPath(req?.repo)
    return repo ? createWorktree(repo) : { ok: false, error: 'bad request' }
  })
  ipcMain.handle(WorktreeChannels.list, (_e, raw: string) => {
    const repo = repoPath(raw)
    return repo ? listWorktrees(repo) : []
  })
  ipcMain.handle(WorktreeChannels.preflight, (_e, raw: string) => {
    const repo = repoPath(raw)
    return repo ? preflightWorktrees(repo) : { ok: false, reason: 'not-a-repo' }
  })
  ipcMain.handle(WorktreeChannels.remove, (_e, req: RemoveWorktreeRequest) => {
    const fault = wizardAuditFaults()
    if (fault) fault.worktreeRemoveCalls++
    const repo = repoPath(req?.repo)
    const path = repoPath(req?.path)
    if (!repo || !path) {
      return { ok: false, reason: 'error' }
    }
    return (async () => {
      const auditFault = worktreeAuditFault()
      if (auditFault) {
        const fold = (value: string): string =>
          process.platform === 'win32' ? value.toLowerCase() : value
        if (fold(path) === fold(auditFault.lockPath)) {
          auditFault.attempts++
          if (auditFault.attempts <= auditFault.failures) {
            return {
              ok: false as const,
              reason: 'error' as const,
              error: 'Injected transient Windows worktree lock.'
            }
          }
        }
      }
      const res = await removeWorktree(repo, path, req.force === true)
      // Reviewer gate (4/03): a removed worktree's branch loses its sign-off —
      // approvals are for LIVE work, never for a branch whose tree is gone.
      if (res.ok) {
        const repoId = await repoIdentity(repo)
        if (repoId) getDaemonClient()?.unapprove(repoId, `mogging/${basename(path)}`)
      }
      return res
    })()
  })
}
