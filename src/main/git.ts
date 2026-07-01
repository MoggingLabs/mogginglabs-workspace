import { ipcMain, type WebContents } from 'electron'
import { GitMonitor } from '@backend/features/git'
import { GitChannels, type GitWatchRequest, type GitUnwatchRequest } from '@contracts'

// App-wiring: expose the read-only git probe to the renderer. The GitMonitor lives in @backend
// (Electron-free, spawns `git` read-only); this file only binds it to IPC. Git probing is a
// main-process concern independent of where PTYs live, so it works identically on the daemon and
// in-proc backends — the cwd comes from the renderer (workspace cwd seed + OSC-7 refinement).
// Carries only a cwd (in) and a small status (out) — never file content or credentials.
export function registerGit(getWebContents: () => WebContents | null): () => void {
  const monitor = new GitMonitor({
    change: (paneId, status) => getWebContents()?.send(GitChannels.change, { paneId, status })
  })
  ipcMain.handle(GitChannels.query, (_e, cwd: string) => monitor.query(cwd))
  ipcMain.on(GitChannels.watch, (_e, req: GitWatchRequest) => void monitor.setCwd(req.paneId, req.cwd))
  ipcMain.on(GitChannels.unwatch, (_e, req: GitUnwatchRequest) => monitor.remove(req.paneId))
  return () => monitor.dispose()
}
