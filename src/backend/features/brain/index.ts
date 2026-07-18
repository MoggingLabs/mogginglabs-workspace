import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { BrainAnswer, BrainRefusal, BrainStatus } from '@contracts'
import { foldProjectKey } from '../workspace/project-identity'
import { resolveBrainProject, type BrainProject } from './project'
import { BrainStore, brainDbPath } from './store'
import type { BrainBuildOutcome, BrainWorkerReply } from './indexer-worker'

export { resolveBrainProject, type BrainProject } from './project'
export { BrainStore, brainDbPath, BRAIN_SCHEMA_VERSION } from './store'
export type { BrainBuildOutcome } from './indexer-worker'

// The brain SERVICE (ADR 0018): the one object every later step consumes — identity,
// lifecycle, status, typed refusals, and (step 03) the FULL deterministic build.
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

  constructor(private readonly opts: BrainServiceOptions) {}

  status(root: string): BrainAnswer {
    const r = this.ensure(root)
    return 'reason' in r ? r : this.answer(r.brain)
  }

  /**
   * The FULL build of the partition `root` stands in, in the worker. Resolves when
   * the ONE transactional commit lands (or the refusal arrives). A second rebuild
   * for the same project while one is in flight is a typed `busy` refusal — no
   * queueing, no silent coalescing (04 owns anything smarter).
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
      const partitionRoot = this.partitionRootFor(r.brain.project, root)
      const outcome = await this.runBuild(partitionRoot, r.brain.project, caps)
      if ('reason' in outcome) return outcome
      return this.answer(r.brain)
    } finally {
      this.building.delete(key)
    }
  }

  /** Live open-db count — the LRU cap's witness for the BRAINCORE smoke. */
  openCount(): number {
    return this.open.size
  }

  /** Close every handle. Idempotent; the next call reopens lazily. */
  dispose(): void {
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

  private answer(brain: OpenBrain): BrainStatus {
    const counts = brain.store.counts()
    const stats = brain.store.buildStats()
    return {
      ok: true,
      projectKey: brain.project.projectKey,
      roots: brain.project.roots,
      generation: brain.store.generation(),
      // Nothing can invalidate the index yet — 04 owns raising `dirty`.
      dirty: false,
      files: counts.files,
      nodes: counts.nodes,
      edges: counts.edges,
      languages: counts.languages,
      indexing: this.building.has(foldProjectKey(brain.project.projectKey)),
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
      try {
        coldest[1].store.dispose()
      } catch {
        /* already closed */
      }
      this.open.delete(coldest[0])
    }
    const brain = { project, store }
    this.open.set(key, brain)
    return { brain }
  }
}
