import * as fs from 'node:fs'

// Pid/pipe liveness primitives. These were copy-pasted five times (agent-proc, the
// daemon's lifecycle, and three src/main daemon files) with an identical ten-line
// comment on two of the copies — @backend/platform is importable from every one of
// those contexts (main and the daemon bundle both already import platform modules),
// so one definition serves them all.

/** Is this pid still running? (Signal 0 — a permission error still means ALIVE.) */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Is a Windows named pipe currently held? Pipes are kernel objects that die WITH their
 *  process, so this is an identity check a recycled pid cannot fake. Non-pipe addresses
 *  (unix sockets persist on disk after death) prove nothing — report true (undecided).
 *
 *  NOT existsSync: checking a named pipe means CreateFile, and a pipe whose pending listener
 *  instance is momentarily consumed answers PIPE_BUSY — which existsSync swallows into
 *  `false`. That declared a LIVE, LISTENING daemon dead: discovery unlinked its endpoint and
 *  blind-spawned a rival that the still-held lock refused, and the boot ended with no daemon
 *  at all (found by the DAEMONCUSTODY gate, whose back-to-back discoveries hit the re-arm
 *  window every time; any two discovery calls a few ms apart could). A busy pipe is a live
 *  pipe. Only "definitely gone" — ENOENT — may kill it; every other answer keeps the
 *  undecided default (true) and lets connect() be the judge, exactly like non-Windows. */
export function pipeAlive(address: string): boolean {
  if (process.platform !== 'win32' || !address.startsWith('\\\\.\\pipe\\')) return true
  try {
    fs.accessSync(address)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
