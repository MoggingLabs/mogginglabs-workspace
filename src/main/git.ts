import { spawn } from 'node:child_process'
import { ipcMain, type WebContents } from 'electron'
import { GitMonitor } from '@backend/features/git'
import { GitChannels, type GitCheckIgnoreRequest, type GitUnwatchRequest, type GitWatchRequest } from '@contracts'

// App-wiring: expose the read-only git probe to the renderer. The GitMonitor lives in @backend
// (Electron-free, spawns `git` read-only); this file only binds it to IPC. Git probing is a
// main-process concern independent of where PTYs live, so it works identically on the daemon and
// in-proc backends — the cwd comes from the renderer (workspace cwd seed + OSC-7 refinement).
// Carries only a cwd (in) and a small status (out) — never file content or credentials.
//
// Phase-11/05 adds the explorer's file-level status on the SAME monitor, the SAME 2.5s tick, and
// the SAME per-repo spawn, plus ONE on-demand verb: `check-ignore`. That verb is the only new
// `git` process in the pack, it is never polled, and the renderer caches its answer per directory
// until a filesystem batch invalidates it — so the ignore dimming costs one spawn per directory
// per real change, and nothing at all at rest.

/** Spawn counter, read by the TREEGIT smoke: the ignore cache must not leak spawns. */
let checkIgnoreSpawns = 0
export function gitCheckIgnoreSpawnsForSmoke(): number {
  return checkIgnoreSpawns
}

/**
 * Which of `paths` does git ignore? Read-only, one batch, bounded. `check-ignore` exits 1 when
 * NOTHING matches — that is an answer, not an error, so only the output is read. We never parse
 * `.gitignore` ourselves: git owns that grammar (negations, precedence, nested files), and a
 * hand-rolled matcher would be wrong in exactly the cases users notice.
 */
function checkIgnore(root: string, paths: string[]): Promise<string[]> {
  if (!root || !paths.length) return Promise.resolve([])
  checkIgnoreSpawns++
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string[]): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const child = spawn('git', ['-C', root, '--no-optional-locks', 'check-ignore', '--stdin'], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.on('error', () => finish([])) // git not on PATH — nothing is "ignored", and nothing breaks
    child.on('close', () =>
      finish(
        out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    )
    child.stdin.on('error', () => undefined) // EPIPE when git exits before we finish writing
    child.stdin.end(paths.join('\n') + '\n')
    const kill = setTimeout(() => {
      child.kill()
      finish([])
    }, 5000)
    child.on('close', () => clearTimeout(kill))
  })
}

export function registerGit(getWebContents: () => WebContents | null): () => void {
  const monitor = new GitMonitor({
    change: (paneId, status) => getWebContents()?.send(GitChannels.change, { paneId, status }),
    files: (payload) => getWebContents()?.send(GitChannels.filesChange, payload)
  })
  ipcMain.handle(GitChannels.query, (_e, cwd: string) => monitor.query(cwd))
  ipcMain.on(GitChannels.watch, (_e, req: GitWatchRequest) => void monitor.setCwd(req.paneId, req.cwd))
  ipcMain.on(GitChannels.unwatch, (_e, req: GitUnwatchRequest) => monitor.remove(req.paneId))

  // ── 11/05: file-level status for the explorer ────────────────────────────────
  ipcMain.handle(GitChannels.filesQuery, (_e, cwd: unknown) => monitor.queryFiles(typeof cwd === 'string' ? cwd : ''))
  ipcMain.on(GitChannels.filesWatch, (_e, cwd: unknown) => void monitor.watchFiles(typeof cwd === 'string' ? cwd : ''))
  ipcMain.on(GitChannels.filesUnwatch, (_e, cwd: unknown) => monitor.unwatchFiles(typeof cwd === 'string' ? cwd : ''))
  ipcMain.handle(GitChannels.checkIgnore, (_e, req: GitCheckIgnoreRequest) =>
    checkIgnore(
      typeof req?.root === 'string' ? req.root : '',
      Array.isArray(req?.paths) ? (req.paths as unknown[]).filter((p): p is string => typeof p === 'string' && !!p) : []
    )
  )

  return () => monitor.dispose()
}
