import type { BrainAnswer, BrainRefusal, BrainStatus } from '@contracts'
import { foldProjectKey } from '../workspace/project-identity'
import { resolveBrainProject, type BrainProject } from './project'
import { BrainStore, brainDbPath } from './store'

export { resolveBrainProject, type BrainProject } from './project'
export { BrainStore, brainDbPath, BRAIN_SCHEMA_VERSION } from './store'

// The brain SERVICE (ADR 0018): the one object every later step consumes — identity,
// lifecycle, status, typed refusals. Electron-free; main hands it the ONE path
// Electron owns (the userData layout) and binds the verbs. This step no parser, no
// walker, no watcher exists — the service's whole job is to make the LAWS true
// before the graph arrives.

/** How many per-project dbs stay open at once: an LRU, because a switcher-happy
 *  session TOUCHES many projects but WORKS in few. Eviction closes the handle —
 *  a brain is cheap to reopen and must never pin a file forever. */
export const BRAIN_OPEN_DB_CAP = 4

interface OpenBrain {
  project: BrainProject
  store: BrainStore
}

export class BrainService {
  /** Insertion-ordered, so the Map IS the LRU: delete + re-set marks recency,
   *  the first key is always the coldest. Keyed by the FOLDED project key. */
  private readonly open = new Map<string, OpenBrain>()

  constructor(private readonly baseDir: string) {}

  status(root: string): BrainAnswer {
    const r = this.ensure(root)
    return 'reason' in r ? r : this.answer(r.brain)
  }

  rebuild(root: string): BrainAnswer {
    const r = this.ensure(root)
    if ('reason' in r) return r
    r.brain.store.bumpGeneration()
    return this.answer(r.brain)
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

  private answer(brain: OpenBrain): BrainStatus {
    return {
      ok: true,
      projectKey: brain.project.projectKey,
      roots: brain.project.roots,
      generation: brain.store.generation(),
      // Nothing can invalidate an empty index yet — 04 owns raising `dirty`.
      dirty: false,
      // Zeroed until 03's graph: a real answer from a real (empty) index.
      files: 0,
      nodes: 0,
      edges: 0,
      languages: [],
      indexing: false
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
      store = new BrainStore(brainDbPath(this.baseDir, project.projectKey))
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
