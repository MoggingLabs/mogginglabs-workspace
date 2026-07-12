import type { GitFileState, GitFiles, GitStatus } from '@contracts'
import { probeGitFull, type GitProbeResult } from './probe'
import { findRepoRoot } from './repo'

// Tracks a cwd per pane and emits the pane's git status whenever it changes. Refresh strategy is
// a single shared POLL (not per-pane fs watchers): bounded, predictable cost that never regresses
// the N-pane perf budget, and dodges the recursive-watch-on-node_modules trap. Each tick probes
// only the DISTINCT repos (panes sharing a repo cost one `git` call), and only emits when a pane's
// status actually changed — so a wall of idle agents produces no IPC churn.
//
// Phase-11/05 adds FILE-level status for the explorer on the SAME tick and the SAME spawn: the
// porcelain lines were already being read and discarded. A registered root does not get a poller
// of its own — it joins this one, and when a pane already tracks that repo (the common case) it
// costs nothing at all, because the per-tick cache is keyed by REPO ROOT.
//
// Electron-free: the sink is injected by the app layer (src/main/git.ts) and wired to IPC there.

export interface GitSink {
  change(paneId: number, status: GitStatus | null): void
  /** 11/05: a registered root's file list changed. Optional, so pre-11/05 sinks still compile. */
  files?(payload: GitFiles): void
}

const DEFAULT_POLL_MS = 2500

export class GitMonitor {
  private readonly cwds = new Map<number, string>() // paneId -> cwd being tracked
  private readonly last = new Map<number, string>() // paneId -> serialized last-emitted status
  private readonly fileRoots = new Set<string>() // repo roots the explorer registered (11/05)
  private readonly lastFiles = new Map<string, string>() // root -> serialized last-emitted file list
  private timer: NodeJS.Timeout | undefined
  private ticking = false

  constructor(
    private readonly sink: GitSink,
    private readonly pollMs = DEFAULT_POLL_MS
  ) {}

  /** One-shot probe (read-only). Used by the query IPC + smokes; does not start tracking. */
  query(cwd: string): Promise<GitStatus | null> {
    return probeGitFull(cwd, false).then((p) => p.status)
  }

  /** One-shot file-level probe (11/05). `null` when `cwd` is not in a repo — and in that case
   *  git is never spawned at all (findRepoRoot is pure filesystem). */
  async queryFiles(cwd: string): Promise<GitFiles | null> {
    const root = findRepoRoot(cwd)
    if (!root) return null
    const p = await probeGitFull(cwd, true)
    return { root, files: p.files ?? [], truncated: p.truncated }
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
    this.stopIfIdle()
  }

  /**
   * 11/05: the explorer registers the folder it is SHOWING. Returns the repo root, or null when
   * `cwd` is not in a repo — in which case nothing is registered, nothing is probed, and not one
   * `git` process is spawned for it, ever (the dormancy rule).
   */
  watchFiles(cwd: string): string | null {
    const root = findRepoRoot(cwd)
    if (!root) return null
    this.fileRoots.add(root)
    this.ensurePolling()
    void this.refreshFiles(root, new Map()) // fill the decorations now, not in 2.5s
    return root
  }

  unwatchFiles(cwd: string): void {
    const root = findRepoRoot(cwd) ?? cwd
    this.fileRoots.delete(root)
    this.lastFiles.delete(root)
    this.stopIfIdle()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.cwds.clear()
    this.last.clear()
    this.fileRoots.clear()
    this.lastFiles.clear()
  }

  private ensurePolling(): void {
    if (this.timer || (this.cwds.size === 0 && this.fileRoots.size === 0)) return
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref?.()
  }

  private stopIfIdle(): void {
    if (this.cwds.size > 0 || this.fileRoots.size > 0 || !this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * ONE spawn per REPO per tick, whether one pane wants it, sixteen do, or the explorer does.
   * The cache is keyed by root (not cwd) because `git -C <root> status` gives the same answer for
   * every cwd inside it — so a registered explorer root that any pane already tracks is free.
   */
  private async probeRepo(cwd: string, cache: Map<string, GitProbeResult>): Promise<GitProbeResult> {
    const root = findRepoRoot(cwd)
    if (!root) return { status: null, files: null, truncated: false }
    const hit = cache.get(root)
    if (hit) return hit
    const res = await probeGitFull(cwd, this.fileRoots.has(root))
    cache.set(root, res)
    return res
  }

  /** Probe one pane (using/filling the per-tick cache) + emit on change. */
  private async refresh(paneId: number, cache: Map<string, GitProbeResult>): Promise<void> {
    const cwd = this.cwds.get(paneId)
    if (cwd === undefined) return
    const { status } = await this.probeRepo(cwd, cache)
    // The pane must still be on the cwd we probed. `has` is not enough: a slow probe of repo A
    // (big repo, cold disk) still in flight when the shell reports a cd into repo B would land
    // AFTER B's probe and overwrite the chip with A's branch and dirty state — the chip lies
    // until the next tick heals it. A retargeted pane's stale probe is simply dropped; setCwd
    // already emitted B.
    if (this.cwds.get(paneId) !== cwd) return // pane removed, or moved on, while probing
    // The pane's signature is its STATUS and nothing else — the file list rides the same probe
    // but must never make a chip re-emit, or every keystroke an agent saves would churn the bar.
    const sig = JSON.stringify(status)
    if (this.last.get(paneId) === sig) return
    this.last.set(paneId, sig)
    this.sink.change(paneId, status)
  }

  /** Emit a registered root's file list — change-only, so an idle repo is silent forever. */
  private async refreshFiles(root: string, cache: Map<string, GitProbeResult>): Promise<void> {
    if (!this.fileRoots.has(root)) return
    const p = await this.probeRepo(root, cache)
    if (!this.fileRoots.has(root) || !p.files) return // unregistered mid-probe, or files not asked for
    const files: GitFileState[] = p.files
    const sig = JSON.stringify(files) + (p.truncated ? '!' : '')
    if (this.lastFiles.get(root) === sig) return
    this.lastFiles.set(root, sig)
    this.sink.files?.({ root, files, truncated: p.truncated })
  }

  private async tick(): Promise<void> {
    if (this.ticking) return // don't overlap if a probe round is still running
    this.ticking = true
    const cache = new Map<string, GitProbeResult>()
    try {
      for (const paneId of [...this.cwds.keys()]) await this.refresh(paneId, cache)
      for (const root of [...this.fileRoots]) await this.refreshFiles(root, cache)
    } finally {
      this.ticking = false
    }
  }
}
