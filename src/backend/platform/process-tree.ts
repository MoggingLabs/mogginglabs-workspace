import { spawn } from 'node:child_process'
import type { IPty } from 'node-pty'

// True process-TREE teardown, so long-running agent children are never orphaned when a
// pane closes. (This file shipped a bare `proc.kill()` under a tree-shaped name for
// eleven phases while its comment promised the replacement "in Phase 1".)
//
//   Windows  ConPTY gives every descendant a distinct pid under the pane shell; a bare
//            kill ends the shell and leaves the agent running headless. `taskkill /T /F`
//            walks the child tree — spawned fire-and-forget (hidden, detached), so the
//            caller stays synchronous exactly as before. `proc.kill()` still runs as the
//            fallback for environments where taskkill is unavailable.
//   POSIX    node-pty forks the shell as a SESSION LEADER (forkpty → setsid), so the
//            shell's pid IS its process-group id. Signalling the group (-pid) reaches
//            every descendant still in it; `proc.kill()` afterwards closes the pty pair,
//            which HUPs whatever moved itself into another group.
export function killPtyTree(proc: IPty): void {
  const pid = proc.pid
  if (Number.isInteger(pid) && pid > 0) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore'
        }).unref()
      } catch {
        /* taskkill unavailable — the plain kill below still ends the shell */
      }
    } else {
      try {
        process.kill(-pid, 'SIGHUP') // the whole session's process group
      } catch {
        /* group already gone, or the shell left it — the plain kill below decides */
      }
    }
  }
  try {
    proc.kill()
  } catch {
    // process may already be gone
  }
}
