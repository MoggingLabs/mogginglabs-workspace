import { app, ipcMain } from 'electron'
import { listDir } from '@backend/features/fs-browse'
import { FsChannels, type ListDirRequest } from '@contracts'

// App-wiring: the folder browser's read-only listing (Phase-8.5/03). The logic lives
// in @backend (Electron-free, testable); main only binds it to a channel and refuses
// malformed input before the backend ever sees it — the `worktrees.ts` posture.
//
// `fs:home` exists because the renderer cannot know where a user's home is, and the
// browser has to open somewhere before a cwd is chosen. It returns one path, nothing else.

export function registerFsBrowse(): void {
  ipcMain.handle(FsChannels.listDir, (_e, req: ListDirRequest) =>
    typeof req?.path === 'string' ? listDir({ path: req.path, showHidden: req.showHidden === true }) : { ok: false, reason: 'invalid', path: '' }
  )
  ipcMain.handle(FsChannels.home, () => app.getPath('home'))
}

export function disposeFsBrowse(): void {
  ipcMain.removeHandler(FsChannels.listDir)
  ipcMain.removeHandler(FsChannels.home)
}
