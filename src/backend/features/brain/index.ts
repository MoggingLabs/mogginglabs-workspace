import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { BrainAnswer, BrainChangedEvent, BrainRefusal, BrainStatus } from '@contracts'
import { foldProjectKey } from '../workspace/project-identity'
import {
  BrainFreshness,
  type BrainDeltaRequest,
  type BrainFreshnessStats,
  type BrainTickSource
} from './freshness'
import { resolveBrainProject, type BrainProject } from './project'
import { BrainStore, brainDbPath } from './store'
import type { BrainBuildOutcome, BrainDeltaOutcome, BrainWorkerReply } from './indexer-worker'

export { resolveBrainProject, type BrainProject } from './project'
export { BrainStore, brainDbPath, BRAIN_SCHEMA_VERSION } from './store'
export type { BrainBuildOutcome, BrainDeltaOutcome } from './indexer-worker'
export {
  BRAIN_DRAIN_QUIET_MS,
  BRAIN_DRAIN_SLICE,
  BRAIN_SWEEP_SLICE,
  BrainFreshness,
  type BrainFreshnessStats,
  type BrainTickPayload,
  type BrainTickSource
} from './freshness'
export { diffHeadMove, headDiffSpawnsForSmoke } from './head'
export {
  BRAIN_SERVE_DEFAULT_LIMIT,
  BRAIN_SERVE_MAX_LIMIT,
  BRAIN_SERVE_DEFAULT_DEPTH,
  BRAIN_SERVE_MAX_DEPTH,
  BRAIN_SERVE_RESPONSE_CAP,
  globToLike,
  serveBrainRead,
  type BrainReadHost,
  type BrainServeReply
} from './serve'

// The brain SERVICE (ADR 0018): the one object every later step consumes — identity,
// lifecycle, status, typed refusals, (step 03) the FULL deterministic build, and
// (step 04) the freshness law: bound to the shared git tick, the service keeps every
// built partition FOLLOWING its root — incremental drains, head-move deltas, a
// cold-start reconcile on first open — with staleness stamped on every answer.
// Electron-free; main hands it the paths Electron owns (userData db dir, the built
// worker file, the grammars dir) and binds the verbs. The build runs ENTIRELY in the
// worker_threads indexer: this thread posts one message and receives progress — the
// frame-safety 11 will measure is built here, not bolted on.

/** How many per-project dbs stay open at once: an LRU, because a switcher-happy
 *  session TOUCHES many projects but WORKS in few. Eviction closes the handle —
 *  a brain is cheap to reopen and must never pin a file forever. */
export const BRAIN_OPEN_DB_CAP = 4

export interface BrainServiceOptions {
  /** Where the per-project dbs live (…/userData/brain). */
  baseDir: string
  /** The built worker file (out/main/brain-worker.js). */
  workerFile: string
  /** The vendored grammar dir (assets/grammars). */
  grammarsDir: string
}

/** Smoke-facing caps override — the contract constants stay the defaults. */
export interface BrainBuildCaps {
  maxFiles?: number
}

interface OpenBrain {
  project: BrainProject
  store: BrainStore
}

export class BrainService {
  /** Insertion-ordered: the Map IS the LRU (delete + re-set marks recency). */
  private readonly open = new Map<string, OpenBrain>()
  /** Folded projectKeys with a build in flight — the `busy` refusal's whole truth. */
  private readonly building = new Set<string>()
  /** Per-project serialization: drains and rebuilds queue, never interleave (04). */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Bumped per landed rebuild — a drain that queued behind one drops its stale slice. */
  private readonly rebuildSeq = new Map<string, number>()
  /** Folded partition root -> projectKey / folded projectKey -> attached roots (04). */
  private readonly rootProject = new Map<string, string>()
  private readonly rootsByProject = new Map<string, string[]>()
  private freshness: BrainFreshness | null = null
  private changedCb: ((e: BrainChangedEvent) => void) | null = null
  private drainEmitCount = 0

  constructor(private readonly opts: BrainServiceOptions) {}

  /**
   * 04: bind the freshness law to the SHARED git tick (the app hands in the one
   * GitMonitor — zero new pollers by construction). Idempotent; without it the
   * service is exactly the 03 service: explicit rebuilds, never-stale `dirty:false`.
   */
  bindTickSource(source: BrainTickSource): void {
    if (this.freshness) return
    this.freshness = new BrainFreshness(source, {
      apply: (root, req) => this.applyFreshness(root, req),
      applied: (root, outcome) => this.emitDrain(root, outcome)
    })
  }

  /** ONE `brain:changed` per landed drain arrives here (plus nothing else — rebuild
   *  emission stays the IPC layer's, exactly as 02 wired it). */
  onChanged(cb: ((e: BrainChangedEvent) => void) | null): void {
    this.changedCb = cb
  }

  status(root: string): BrainAnswer {
    const r = this.ensure(root)
    return 'reason' in r ? r : this.answer(r.brain)
  }

  /** The serve layer's one door (step 05): project identity + the open store +
   *  a fresh stamped status, or the same typed refusals status gives. Reads only
   *  ever flow through this — nothing here can mutate. */
  readHandle(root: string): { project: BrainProject; store: BrainStore; status: BrainStatus } | BrainRefusal {
    const r = this.ensure(root)
    if ('reason' in r) return r
    return { project: r.brain.project, store: r.brain.store, status: this.answer(r.brain) }
  }

  /**
   * The FULL build of the partition `root` stands in, in the worker. Resolves when
   * the ONE transactional commit lands (or the refusal arrives). A second rebuild
   * for the same project while one is in flight is a typed `busy` refusal — no
   * queueing, no silent coalescing. A DRAIN in flight is different: rebuild quietly
   * queues behind it (drains are short; the big hammer stays available).
   */
  async rebuild(root: string, caps?: BrainBuildCaps): Promise<BrainAnswer> {
    const r = this.ensure(root)
    if ('reason' in r) return r
    const key = foldProjectKey(r.brain.project.projectKey)
    if (this.building.has(key)) {
      return { ok: false, reason: 'busy', detail: 'a rebuild is already in flight for this project' }
    }
    this.building.add(key)
    try {
      return await this.runExclusive(key, async (): Promise<BrainAnswer> => {
        const partitionRoot = this.partitionRootFor(r.brain.project, root)
        const outcome = await this.runBuild(partitionRoot, r.brain.project, caps)
        if ('reason' in outcome) return outcome
        // The walk this build committed is total truth for its partition: supersede any
        // queued drain slice, re-baseline the freshness state, attach a first build.
        this.rebuildSeq.set(key, (this.rebuildSeq.get(key) ?? 0) + 1)
        this.afterRebuild(r.brain, partitionRoot)
        return this.answer(r.brain)
      })
    } finally {
      this.building.delete(key)
    }
  }

  /** Live open-db count — the LRU cap's witness for the BRAINCORE smoke. */
  openCount(): number {
    return this.open.size
  }

  /** Freshness counters for one partition root — the BRAINFRESH smoke's witness. */
  freshnessStats(root: string): BrainFreshnessStats | null {
    return this.freshness?.statsFor(root) ?? null
  }

  /** How many drain-landed `brain:changed` emissions left this service. */
  drainEmits(): number {
    return this.drainEmitCount
  }

  /** Close every handle and stop following every root. Idempotent; the next call
   *  reopens (and re-attaches, via the cold-start reconcile) lazily. */
  dispose(): void {
    this.freshness?.dispose()
    this.rootProject.clear()
    this.rootsByProject.clear()
    for (const { store } of this.open.values()) {
      try {
        store.dispose()
      } catch {
        /* already closed */
      }
    }
    this.open.clear()
  }

  /** The canonical dump of a project's db — the BRAINGRAPH gate's spine. */
  dump(root: string): string | null {
    const r = this.ensure(root)
    return 'reason' in r ? null : r.brain.store.dumpCanonical()
  }

  /** Queue work behind whatever the project is already doing — a drain never overlaps
   *  a rebuild, two drains never overlap each other, and a failure never dams the queue. */
  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  /** The freshness layer's one door into the worker: serialize, guard against a rebuild
   *  having superseded the slice, run the incremental op. Null = refused; the dirt stays. */
  private applyFreshness(root: string, req: BrainDeltaRequest): Promise<BrainDeltaOutcome | null> {
    const pre = this.ensure(root)
    if ('reason' in pre) return Promise.resolve(null)
    const key = foldProjectKey(pre.brain.project.projectKey)
    const seq = this.rebuildSeq.get(key) ?? 0
    return this.runExclusive(key, async (): Promise<BrainDeltaOutcome | null> => {
      const r = this.ensure(root) // the LRU may have moved under the queue
      if ('reason' in r) return null
      if ((this.rebuildSeq.get(key) ?? 0) !== seq) {
        // A rebuild landed first: its walk already covered this slice. An honest no-op.
        return {
          generation: r.brain.store.generation(),
          applied: false,
          processed: 0,
          removed: [],
          records: [],
          files: 0,
          nodes: 0,
          edges: 0,
          resolvedRefs: 0,
          droppedRefs: 0,
          cacheHits: 0,
          cacheMisses: 0
        }
      }
      const partitionRoot = this.partitionRootFor(r.brain.project, root)
      const outcome = await this.runDelta(partitionRoot, r.brain.project, req)
      return 'reason' in outcome ? null : outcome
    })
  }

  private emitDrain(root: string, outcome: BrainDeltaOutcome): void {
    this.drainEmitCount += 1
    const projectKey = this.rootProject.get(foldProjectKey(root))
    if (!projectKey || !this.changedCb) return
    const roots = this.rootsByProject.get(foldProjectKey(projectKey)) ?? [root]
    const dirty = roots.some((r) => (this.freshness?.dirtyCount(r) ?? 0) > 0)
    this.changedCb({ projectKey, generation: outcome.generation, dirty })
  }

  /** Start following one BUILT partition. An empty partition is not followed — freshness
   *  keeps an index current; it never grows one from nothing (the rebuild is that verb). */
  private attachRoot(project: BrainProject, root: string, store: BrainStore, reconcile: boolean): void {
    if (!this.freshness || this.freshness.attached(root)) return
    const rows = store.filesForRoot(root)
    if (!rows.length) return
    this.freshness.attach(root, rows, reconcile)
    const pKey = foldProjectKey(project.projectKey)
    this.rootProject.set(foldProjectKey(root), project.projectKey)
    const list = this.rootsByProject.get(pKey) ?? []
    if (!list.some((r) => foldProjectKey(r) === foldProjectKey(root))) list.push(root)
    this.rootsByProject.set(pKey, list)
  }

  /** A cold OPEN of built partitions: follow them, and heal what happened while the app
   *  was closed — the first drain trusts the walk (hash-compare, mtime prefilter). */
  private attachProject(brain: OpenBrain): void {
    if (!this.freshness) return
    for (const root of brain.project.roots) this.attachRoot(brain.project, root, brain.store, true)
  }

  private afterRebuild(brain: OpenBrain, partitionRoot: string): void {
    if (!this.freshness) return
    if (this.freshness.attached(partitionRoot)) {
      this.freshness.reseed(partitionRoot, brain.store.filesForRoot(partitionRoot))
    } else {
      this.attachRoot(brain.project, partitionRoot, brain.store, false)
    }
  }

  /** Stop following a project's roots (eviction, disposal). */
  private detachProject(projectKey: string): void {
    const pKey = foldProjectKey(projectKey)
    for (const root of this.rootsByProject.get(pKey) ?? []) {
      this.freshness?.detach(root)
      this.rootProject.delete(foldProjectKey(root))
    }
    this.rootsByProject.delete(pKey)
  }

  /** The partition key: the project root the caller stands in, in the ROOTS list's
   *  spelling (fold-compared), so rebuild and dump can never disagree on identity. */
  private partitionRootFor(project: BrainProject, root: string): string {
    const resolved = path.resolve(root)
    return (
      project.roots.find((r) => foldProjectKey(r) === foldProjectKey(resolved)) ?? resolved
    )
  }

  private runBuild(
    partitionRoot: string,
    project: BrainProject,
    caps?: BrainBuildCaps
  ): Promise<BrainBuildOutcome | BrainRefusal> {
    const dbPath = brainDbPath(this.opts.baseDir, project.projectKey)
    return new Promise((resolve) => {
      const worker = new Worker(this.opts.workerFile, {
        workerData: { grammarsDir: this.opts.grammarsDir }
      })
      const finish = (value: BrainBuildOutcome | BrainRefusal): void => {
        void worker.terminate()
        resolve(value)
      }
      worker.on('message', (reply: BrainWorkerReply) => {
        if ('build' in reply) finish(reply.build)
        else if ('refusal' in reply) {
          finish({
            ok: false,
            reason: reply.refusal.reason,
            detail: `${reply.refusal.fileCount} files enumerated, cap ${reply.refusal.cap}`
          })
        } else if ('error' in reply) {
          finish({ ok: false, reason: 'busy', detail: reply.error })
        }
        // progress replies: the main thread's whole job is to NOT do the work —
        // nothing to forward yet (04 owns surfacing it).
      })
      worker.on('error', (e) => finish({ ok: false, reason: 'busy', detail: String(e) }))
      worker.postMessage({
        id: 1,
        op: 'build',
        dbPath,
        root: partitionRoot,
        ...(caps?.maxFiles !== undefined ? { maxFiles: caps.maxFiles } : {})
      })
    })
  }

  private runDelta(
    partitionRoot: string,
    project: BrainProject,
    req: BrainDeltaRequest
  ): Promise<BrainDeltaOutcome | BrainRefusal> {
    const dbPath = brainDbPath(this.opts.baseDir, project.projectKey)
    return new Promise((resolve) => {
      const worker = new Worker(this.opts.workerFile, {
        workerData: { grammarsDir: this.opts.grammarsDir }
      })
      const finish = (value: BrainDeltaOutcome | BrainRefusal): void => {
        void worker.terminate()
        resolve(value)
      }
      worker.on('message', (reply: BrainWorkerReply) => {
        if ('delta' in reply) finish(reply.delta)
        else if ('refusal' in reply) {
          finish({
            ok: false,
            reason: reply.refusal.reason,
            detail: `${reply.refusal.fileCount} files enumerated, cap ${reply.refusal.cap}`
          })
        } else if ('error' in reply) {
          finish({ ok: false, reason: 'busy', detail: reply.error })
        }
      })
      worker.on('error', (e) => finish({ ok: false, reason: 'busy', detail: String(e) }))
      worker.postMessage({
        id: 1,
        op: req.reconcile ? 'reconcile' : 'applyDelta',
        dbPath,
        root: partitionRoot,
        changed: req.changed,
        deleted: req.deleted
      })
    })
  }

  private answer(brain: OpenBrain): BrainStatus {
    const counts = brain.store.counts()
    const stats = brain.store.buildStats()
    return {
      ok: true,
      projectKey: brain.project.projectKey,
      roots: brain.project.roots,
      generation: brain.store.generation(),
      // The freshness law (04): staleness is DATA. `dirty` is the honest count of paths
      // (any root) the index has seen move and not yet absorbed — never a blocking wait.
      dirty: brain.project.roots.some((r) => (this.freshness?.dirtyCount(r) ?? 0) > 0),
      files: counts.files,
      nodes: counts.nodes,
      edges: counts.edges,
      languages: counts.languages,
      indexing:
        this.building.has(foldProjectKey(brain.project.projectKey)) ||
        brain.project.roots.some((r) => this.freshness?.draining(r) ?? false),
      resolvedRefs: stats.resolvedRefs,
      droppedRefs: stats.droppedRefs,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses
    }
  }

  private ensure(root: string): { brain: OpenBrain } | BrainRefusal {
    const project = resolveBrainProject(root)
    if ('reason' in project) return project
    const key = foldProjectKey(project.projectKey)
    const existing = this.open.get(key)
    if (existing) {
      // Refresh recency AND the roots list — a worktree may have appeared since.
      this.open.delete(key)
      const brain = { project, store: existing.store }
      this.open.set(key, brain)
      return { brain }
    }
    let store: BrainStore
    try {
      store = new BrainStore(brainDbPath(this.opts.baseDir, project.projectKey))
    } catch (e) {
      // A locked or unopenable db is a REFUSAL, not a crash: the store is derived
      // state, so the honest recovery (delete + rebuild) is the caller's explicit
      // move, never a silent one here.
      return { ok: false, reason: 'busy', detail: e instanceof Error ? e.message : String(e) }
    }
    while (this.open.size >= BRAIN_OPEN_DB_CAP) {
      const coldest = this.open.entries().next().value
      if (!coldest) break
      // An evicted brain stops being followed too: freshness state is bookkeeping FOR an
      // open handle, and the cold-start reconcile heals whatever happens while evicted.
      this.detachProject(coldest[1].project.projectKey)
      try {
        coldest[1].store.dispose()
      } catch {
        /* already closed */
      }
      this.open.delete(coldest[0])
    }
    const brain = { project, store }
    this.open.set(key, brain)
    this.attachProject(brain)
    return { brain }
  }
}
