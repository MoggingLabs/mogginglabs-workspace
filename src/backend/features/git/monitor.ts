import { watch as watchFs, type FSWatcher } from 'node:fs'
import type { GitFileState, GitFiles, GitStatus } from '@contracts'
import { invalidateGitDivergence, probeGitFull, type GitProbeResult } from './probe'
import { findRepoRoot, gitMetadataWatchDirs } from './repo'

// Tracks a cwd per pane and emits the pane's git status whenever it changes. Refresh combines a
// single shared POLL with deduplicated watches of Git administrative directories: bounded,
// predictable cost that dodges recursive worktree/node_modules watches. Each tick probes
// only the DISTINCT worktrees (panes sharing one cost one status call), and only emits when a pane's
// status actually changed — so a wall of idle agents produces no IPC churn.
//
// Phase-11/05 adds FILE-level status for the explorer on the SAME tick and the SAME spawn: the
// porcelain lines were already being read and discarded. A registered root does not get a poller
// of its own — it joins this one, and when a pane already tracks that repo (the common case) it
// costs nothing at all, because the per-tick cache is keyed by WORKTREE ROOT. Base divergence is
// cached across ticks and recomputed only when HEAD/base metadata moves.
//
// Electron-free: the sink is injected by the app layer (src/main/git.ts) and wired to IPC there.

export interface GitSink {
  change(paneId: number, status: GitStatus | null): void
  /** 11/05: a registered root's file list changed. Optional, so pre-11/05 sinks still compile. */
  files?(payload: GitFiles): void
}

const DEFAULT_POLL_MS = 2500
const METADATA_DEBOUNCE_MS = 80
const MAX_CONCURRENT_PROBES = 4

interface MetadataWatch {
  watcher: FSWatcher
  roots: Set<string>
}

type GitProbe = (cwd: string, wantFiles?: boolean, allowDivergenceCache?: boolean) => Promise<GitProbeResult>

export class GitMonitor {
  private readonly cwds = new Map<number, string>() // paneId -> cwd being tracked
  private readonly last = new Map<number, string>() // paneId -> serialized last-emitted status
  private readonly refreshSeq = new Map<number, number>() // paneId -> newest monotonic probe token
  private readonly fileRoots = new Set<string>() // repo roots the explorer registered (11/05)
  private readonly lastFiles = new Map<string, string>() // root -> serialized last-emitted file list
  private readonly metadataWatches = new Map<string, MetadataWatch>() // canonical dir -> shared watcher
  private timer: NodeJS.Timeout | undefined
  private metadataTimer: NodeJS.Timeout | undefined
  private ticking = false
  private rerun = false
  private nextRefreshSeq = 0
  private activeProbes = 0
  private readonly probeQueue: Array<() => void> = []

  constructor(
    private readonly sink: GitSink,
    private readonly pollMs = DEFAULT_POLL_MS,
    private readonly probe: GitProbe = probeGitFull
  ) {}

  /** One-shot probe (read-only). Used by the query IPC + smokes; does not start tracking. */
  query(cwd: string): Promise<GitStatus | null> {
    // A one-shot query promises present truth and has no metadata watcher to invalidate a cache.
    return this.withProbeSlot(() => this.probe(cwd, false)).then((p) => p.status)
  }

  /** One-shot file-level probe (11/05). `null` when `cwd` is not in a repo — and in that case
   *  git is never spawned at all (findRepoRoot is pure filesystem). */
  async queryFiles(cwd: string): Promise<GitFiles | null> {
    const root = findRepoRoot(cwd)
    if (!root) return null
    const p = await this.withProbeSlot(() => this.probe(cwd, true))
    return { root, files: p.files ?? [], truncated: p.truncated }
  }

  /** Start (or retarget) tracking a pane's cwd. Probes immediately so the chip fills fast. */
  async setCwd(paneId: number, cwd: string): Promise<void> {
    const prev = this.cwds.get(paneId)
    this.cwds.set(paneId, cwd)
    if (prev !== cwd) {
      this.last.delete(paneId) // cwd changed -> force a fresh emit
      this.sink.change(paneId, null) // retire stale branch/worktree identity immediately
    }
    this.syncMetadataWatches()
    this.ensurePolling()
    await this.refresh(paneId, new Map())
  }

  /** Stop tracking a pane (e.g. it was disposed). Stops the poll when nothing is tracked. */
  remove(paneId: number): void {
    this.cwds.delete(paneId)
    this.last.delete(paneId)
    // Invalidate an in-flight predecessor without resetting its sequence. Pane ids are reused;
    // a successor on the same cwd must not accept the predecessor's late result (ABA).
    this.refreshSeq.set(paneId, ++this.nextRefreshSeq)
    this.syncMetadataWatches()
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
    this.syncMetadataWatches()
    this.ensurePolling()
    void this.refreshFiles(root, new Map()) // fill the decorations now, not in 2.5s
    return root
  }

  unwatchFiles(cwd: string): void {
    const root = findRepoRoot(cwd) ?? cwd
    this.fileRoots.delete(root)
    this.lastFiles.delete(root)
    this.syncMetadataWatches()
    this.stopIfIdle()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.metadataTimer) clearTimeout(this.metadataTimer)
    this.timer = undefined
    this.metadataTimer = undefined
    for (const entry of this.metadataWatches.values()) entry.watcher.close()
    this.metadataWatches.clear()
    this.cwds.clear()
    this.last.clear()
    this.refreshSeq.clear()
    this.fileRoots.clear()
    this.lastFiles.clear()
  }

  /** Watch only Git's small administrative directories. Branch switches, commits, staging,
   * rebases, and linked-worktree ref moves wake the shared monitor immediately; ordinary file
   * edits remain on the bounded poll, avoiding recursive watches of large repositories. */
  private syncMetadataWatches(): void {
    const roots = new Set<string>(this.fileRoots)
    for (const cwd of this.cwds.values()) {
      const root = findRepoRoot(cwd)
      if (root) roots.add(root)
    }

    const desired = new Map<string, { dir: string; roots: Set<string> }>()
    for (const root of roots) {
      for (const dir of gitMetadataWatchDirs(root)) {
        const key = process.platform === 'win32' ? dir.toLocaleLowerCase('en-US') : dir
        const target = desired.get(key) ?? { dir, roots: new Set<string>() }
        target.roots.add(root)
        desired.set(key, target)
      }
    }

    for (const [key, entry] of this.metadataWatches) {
      const target = desired.get(key)
      if (!target) {
        entry.watcher.close()
        this.metadataWatches.delete(key)
      } else {
        entry.roots = target.roots
      }
    }

    for (const [key, target] of desired) {
      if (this.metadataWatches.has(key)) continue
      try {
        const entry = {} as MetadataWatch
        const watcher = watchFs(target.dir, { persistent: false }, () => {
          for (const root of entry.roots) invalidateGitDivergence(root)
          this.scheduleMetadataRefresh()
        })
        entry.watcher = watcher
        entry.roots = target.roots
        this.metadataWatches.set(key, entry)
        watcher.on('error', () => {
          if (this.metadataWatches.get(key) !== entry) return
          watcher.close()
          this.metadataWatches.delete(key) // the poll remains the correctness fallback
        })
      } catch {
        /* unavailable watch path/handle: the poll remains authoritative */
      }
    }
  }

  private scheduleMetadataRefresh(): void {
    if (this.metadataTimer) clearTimeout(this.metadataTimer)
    this.metadataTimer = setTimeout(() => {
      this.metadataTimer = undefined
      void this.tick(true)
    }, METADATA_DEBOUNCE_MS)
    this.metadataTimer.unref?.()
  }

  private ensurePolling(): void {
    if (this.timer || (this.cwds.size === 0 && this.fileRoots.size === 0)) return
    this.timer = setInterval(() => void this.tick(false), this.pollMs)
    this.timer.unref?.()
  }

  private stopIfIdle(): void {
    if (this.cwds.size > 0 || this.fileRoots.size > 0 || !this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Bound Git subprocess pressure across interval, metadata, and immediate probes. */
  private withProbeSlot<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.activeProbes++
        void run()
          .then(resolve, reject)
          .finally(() => {
            this.activeProbes--
            this.probeQueue.shift()?.()
          })
      }
      if (this.activeProbes < MAX_CONCURRENT_PROBES) start()
      else this.probeQueue.push(start)
    })
  }

  /**
   * ONE status spawn per WORKTREE per tick, whether one pane wants it, sixteen do, or the explorer does.
   * The cache is keyed by root (not cwd) because `git -C <root> status` gives the same answer for
   * every cwd inside it — so a registered explorer root that any pane already tracks is free.
   */
  private probeRepo(cwd: string, cache: Map<string, Promise<GitProbeResult>>): Promise<GitProbeResult> {
    const root = findRepoRoot(cwd)
    if (!root) return Promise.resolve({ status: null, files: null, truncated: false })
    const hit = cache.get(root)
    if (hit) return hit
    // Store the promise before another pane can ask for this root. The tick fans out all panes
    // concurrently, but a worktree still owns exactly one status process/result per round.
    const pending = this.withProbeSlot(() => this.probe(cwd, this.fileRoots.has(root), true))
    cache.set(root, pending)
    return pending
  }

  /** Probe one pane (using/filling the per-tick cache) + emit on change. */
  private async refresh(paneId: number, cache: Map<string, Promise<GitProbeResult>>): Promise<void> {
    const cwd = this.cwds.get(paneId)
    if (cwd === undefined) return
    const seq = ++this.nextRefreshSeq
    this.refreshSeq.set(paneId, seq)
    const { status } = await this.probeRepo(cwd, cache)
    // The pane must still be on the cwd we probed. `has` is not enough: a slow probe of repo A
    // (big repo, cold disk) still in flight when the shell reports a cd into repo B would land
    // AFTER B's probe and overwrite the chip with A's branch and dirty state — the chip lies
    // until the next tick heals it. A retargeted pane's stale probe is simply dropped; setCwd
    // already emitted B.
    if (this.cwds.get(paneId) !== cwd || this.refreshSeq.get(paneId) !== seq) return
    // The pane's signature is its STATUS and nothing else — the file list rides the same probe
    // but must never make a chip re-emit, or every keystroke an agent saves would churn the bar.
    const sig = JSON.stringify(status)
    if (this.last.get(paneId) === sig) return
    this.last.set(paneId, sig)
    this.sink.change(paneId, status)
  }

  /** Emit a registered root's file list — change-only, so an idle repo is silent forever. */
  private async refreshFiles(root: string, cache: Map<string, Promise<GitProbeResult>>): Promise<void> {
    if (!this.fileRoots.has(root)) return
    const p = await this.probeRepo(root, cache)
    if (!this.fileRoots.has(root) || !p.files) return // unregistered mid-probe, or files not asked for
    const files: GitFileState[] = p.files
    const sig = JSON.stringify(files) + (p.truncated ? '!' : '')
    if (this.lastFiles.get(root) === sig) return
    this.lastFiles.set(root, sig)
    this.sink.files?.({ root, files, truncated: p.truncated })
  }

  private async tick(metadataWake: boolean): Promise<void> {
    if (this.ticking) {
      // An ordinary interval overlapping a slow round is skipped, preserving the bounded poll.
      // A metadata event is different: HEAD/base moved mid-probe, so run once more immediately.
      if (metadataWake) this.rerun = true
      return
    }
    this.ticking = true
    const cache = new Map<string, Promise<GitProbeResult>>()
    try {
      await Promise.all([...this.cwds.keys()].map((paneId) => this.refresh(paneId, cache)))
      await Promise.all([...this.fileRoots].map((root) => this.refreshFiles(root, cache)))
    } finally {
      this.ticking = false
      if (this.rerun) {
        this.rerun = false
        queueMicrotask(() => void this.tick(false))
      }
    }
  }
}
