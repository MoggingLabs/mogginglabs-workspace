import type { GitStatus } from '@contracts'
import { probeGit } from './probe'

// Tracks a cwd per pane and emits the pane's git status whenever it changes. Refresh strategy is
// a single shared POLL (not per-pane fs watchers): bounded, predictable cost that never regresses
// the N-pane perf budget, and dodges the recursive-watch-on-node_modules trap. Each tick probes
// only the DISTINCT cwds (panes sharing a workspace dir cost one `git` call), and only emits when
// a pane's status actually changed — so a wall of idle agents produces no IPC churn.
//
// Electron-free: the sink is injected by the app layer (src/main/git.ts) and wired to IPC there.

export interface GitSink {
  change(paneId: number, status: GitStatus | null): void
}

const DEFAULT_POLL_MS = 2500

export class GitMonitor {
  private readonly cwds = new Map<number, string>() // paneId -> cwd being tracked
  private readonly last = new Map<number, string>() // paneId -> serialized last-emitted status
  private timer: NodeJS.Timeout | undefined
  private ticking = false

  constructor(
    private readonly sink: GitSink,
    private readonly pollMs = DEFAULT_POLL_MS
  ) {}

  /** One-shot probe (read-only). Used by the query IPC + smokes; does not start tracking. */
  query(cwd: string): Promise<GitStatus | null> {
    return probeGit(cwd)
  }

  /** Start (or retarget) tracking a pane's cwd. Probes immediately so the chip fills fast. */
  async setCwd(paneId: number, cwd: string): Promise<void> {
    const prev = this.cwds.get(paneId)
    this.cwds.set(paneId, cwd)
    if (prev !== cwd) this.last.delete(paneId) // cwd changed -> force a fresh emit
    this.ensurePolling()
    await this.refresh(paneId, new Map())
  }

  /** Stop tracking a pane (e.g. it was disposed). Stops the poll when nothing is tracked. */
  remove(paneId: number): void {
    this.cwds.delete(paneId)
    this.last.delete(paneId)
    if (this.cwds.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.cwds.clear()
    this.last.clear()
  }

  private ensurePolling(): void {
    if (this.timer || this.cwds.size === 0) return
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  /** Probe one pane (using/filling a per-tick cache so shared cwds probe once) + emit on change. */
  private async refresh(paneId: number, cache: Map<string, GitStatus | null>): Promise<void> {
    const cwd = this.cwds.get(paneId)
    if (cwd === undefined) return
    let status: GitStatus | null
    if (cache.has(cwd)) {
      status = cache.get(cwd) ?? null
    } else {
      status = await probeGit(cwd)
      cache.set(cwd, status)
    }
    if (!this.cwds.has(paneId)) return // pane removed while probing
    const sig = JSON.stringify(status)
    if (this.last.get(paneId) === sig) return
    this.last.set(paneId, sig)
    this.sink.change(paneId, status)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return // don't overlap if a probe round is still running
    this.ticking = true
    const cache = new Map<string, GitStatus | null>()
    try {
      for (const paneId of [...this.cwds.keys()]) await this.refresh(paneId, cache)
    } finally {
      this.ticking = false
    }
  }
}
