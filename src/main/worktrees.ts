import { ipcMain } from 'electron'
import { createWorktree, listWorktrees, removeWorktree } from '@backend/features/worktrees'
import {
  WorktreeChannels,
  type CreateWorktreeRequest,
  type RemoveWorktreeRequest
} from '@contracts'
import { basename } from 'node:path'
import { getDaemonClient } from './daemon-relay'

// App-wiring: bind the Electron-free worktree module (Phase-3/03) to IPC — the same
// shape as registerGit. Paths + branch names only; dirty-safe removal is enforced in
// the backend module, not here.
export function registerWorktrees(): void {
  ipcMain.handle(WorktreeChannels.create, (_e, req: CreateWorktreeRequest) =>
    typeof req?.repo === 'string' && req.repo ? createWorktree(req.repo) : { ok: false, error: 'bad request' }
  )
  ipcMain.handle(WorktreeChannels.list, (_e, repo: string) =>
    typeof repo === 'string' && repo ? listWorktrees(repo) : []
  )
  ipcMain.handle(WorktreeChannels.remove, (_e, req: RemoveWorktreeRequest) => {
    if (typeof req?.repo !== 'string' || typeof req?.path !== 'string') {
      return { ok: false, reason: 'error' }
    }
    return (async () => {
      const res = await removeWorktree(req.repo, req.path, req.force === true)
      // Reviewer gate (4/03): a removed worktree's branch loses its sign-off —
      // approvals are for LIVE work, never for a branch whose tree is gone.
      if (res.ok) getDaemonClient()?.unapprove(`mogging/${basename(req.path)}`)
      return res
    })()
  })
}
