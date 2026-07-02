import { ipcMain } from 'electron'
import { createWorktree, listWorktrees, removeWorktree } from '@backend/features/worktrees'
import {
  WorktreeChannels,
  type CreateWorktreeRequest,
  type RemoveWorktreeRequest
} from '@contracts'

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
  ipcMain.handle(WorktreeChannels.remove, (_e, req: RemoveWorktreeRequest) =>
    typeof req?.repo === 'string' && typeof req?.path === 'string'
      ? removeWorktree(req.repo, req.path, req.force === true)
      : { ok: false, reason: 'error' }
  )
}
