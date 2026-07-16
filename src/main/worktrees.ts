import { ipcMain } from 'electron'
import { createWorktree, listWorktrees, removeWorktree } from '@backend/features/worktrees'
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
export function registerWorktrees(): void {
  ipcMain.handle(WorktreeChannels.create, async (_e, req: CreateWorktreeRequest) => {
    const fault = wizardAuditFaults()
    if (fault) {
      fault.worktreeCreateCalls++
      await auditDelay(fault.worktreeDelayMs)
      if (fault.worktreeFailAt === fault.worktreeCreateCalls) {
        return { ok: false, error: 'injected worktree creation failure' }
      }
    }
    return typeof req?.repo === 'string' && req.repo ? createWorktree(req.repo) : { ok: false, error: 'bad request' }
  })
  ipcMain.handle(WorktreeChannels.list, (_e, repo: string) =>
    typeof repo === 'string' && repo ? listWorktrees(repo) : []
  )
  ipcMain.handle(WorktreeChannels.remove, (_e, req: RemoveWorktreeRequest) => {
    const fault = wizardAuditFaults()
    if (fault) fault.worktreeRemoveCalls++
    if (typeof req?.repo !== 'string' || typeof req?.path !== 'string') {
      return { ok: false, reason: 'error' }
    }
    return (async () => {
      const auditFault = worktreeAuditFault()
      if (auditFault) {
        const fold = (value: string): string =>
          process.platform === 'win32' ? value.toLowerCase() : value
        if (fold(req.path) === fold(auditFault.lockPath)) {
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
      const res = await removeWorktree(req.repo, req.path, req.force === true)
      // Reviewer gate (4/03): a removed worktree's branch loses its sign-off —
      // approvals are for LIVE work, never for a branch whose tree is gone.
      if (res.ok) {
        const repoId = await repoIdentity(req.repo)
        if (repoId) getDaemonClient()?.unapprove(repoId, `mogging/${basename(req.path)}`)
      }
      return res
    })()
  })
}
