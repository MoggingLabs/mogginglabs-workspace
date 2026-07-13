import { closeSync, openSync, readSync, rmSync, statSync, truncateSync, watch, type FSWatcher } from 'node:fs'

const SETUP_MARKER = 'setup: worktree: '
const MAX_INCREMENT_BYTES = 1024 * 1024

/** Parse Git's documented GIT_TRACE_SETUP worktree line. This target contains repository setup
 * paths, not argv; malformed/quoted control-path forms are left for cwd validation to reject. */
export function parseGitSetupWorktrees(text: string): string[] {
  const paths: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const at = line.indexOf(SETUP_MARKER)
    if (at === -1) continue
    const worktree = line.slice(at + SETUP_MARKER.length)
    if (worktree && worktree !== '(null)') paths.push(worktree)
  }
  return paths
}

/** Incrementally tails one private per-pane GIT_TRACE_SETUP file. fs.watch is the normal wakeup;
 * PTY output also calls drain(), covering filesystems that coalesce watch notifications. */
export class GitContextObserver {
  private watcher?: FSWatcher
  private offset = 0
  private remainder = ''
  private draining = false
  private disposed = false

  constructor(
    readonly file: string,
    private readonly emit: (worktree: string) => void
  ) {
    try {
      this.watcher = watch(file, { persistent: false }, () => this.drain())
      this.watcher.on('error', () => {
        try {
          this.watcher?.close()
        } catch {
          /* already closed */
        }
        this.watcher = undefined
      })
    } catch {
      // PTY output still provides a best-effort drain trigger.
    }
    this.drain()
  }

  drain(): void {
    if (this.disposed || this.draining) return
    this.draining = true
    try {
      const size = statSync(this.file).size
      if (size < this.offset) {
        this.offset = 0
        this.remainder = ''
      }
      if (size === this.offset) return
      let start = this.offset
      if (size - start > MAX_INCREMENT_BYTES) {
        start = size - MAX_INCREMENT_BYTES
        this.remainder = ''
      }
      const bytes = Buffer.allocUnsafe(size - start)
      const fd = openSync(this.file, 'r')
      let read = 0
      try {
        while (read < bytes.length) {
          const count = readSync(fd, bytes, read, bytes.length - read, start + read)
          if (!count) break
          read += count
        }
      } finally {
        closeSync(fd)
      }
      this.offset = start + read
      const combined = this.remainder + bytes.subarray(0, read).toString('utf8')
      const newline = combined.lastIndexOf('\n')
      const complete = newline === -1 ? '' : combined.slice(0, newline + 1)
      this.remainder = newline === -1 ? combined : combined.slice(newline + 1)
      for (const worktree of parseGitSetupWorktrees(complete)) this.emit(worktree)
    } catch {
      // Missing, locked, or concurrently replaced trace files are non-authoritative evidence.
    } finally {
      this.draining = false
    }
  }

  /** Retire the completed command's trace at an authoritative shell-prompt boundary. Git
   * children in the foreground have exited before the prompt is rendered, so this avoids the
   * append race inherent in compacting a live trace. A late background append is drained while
   * the next command window is closed and therefore cannot relabel the pane. */
  resetAtPrompt(): void {
    if (this.disposed) return
    try {
      truncateSync(this.file, 0)
      this.offset = 0
      this.remainder = ''
    } catch {
      // Missing or locked trace files are non-authoritative evidence.
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.drain()
    this.disposed = true
    try {
      this.watcher?.close()
    } catch {
      /* already closed */
    }
    try {
      rmSync(this.file, { force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      /* a just-exiting Git process can retain the append handle briefly on Windows */
    }
  }
}
