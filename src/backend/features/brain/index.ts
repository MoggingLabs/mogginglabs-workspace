import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import writeFileAtomic from 'write-file-atomic'
import { BRAIN_DRAFT_MAX_AGE_DAYS, BRAIN_MAX_DRAFTS, type BrainAnswer, type BrainChangedEvent, type BrainRefusal, type BrainStatus } from '@contracts'
import { foldProjectKey } from '../workspace/project-identity'
import { serializeDraft, type CaptureDraft, type DraftDistillation } from './capture'
import { EMBED_BATCH, embedTextOfMemory, embedTexts, vectorToBlob, type EmbedTarget } from './embed'
import {
  BrainFreshness,
  type BrainDeltaRequest,
  type BrainFreshnessStats,
  type BrainTickSource
} from './freshness'
import {
  MEMORY_DIR,
  MEMORY_DRAFTS_DIRNAME,
  MEMORY_MAX_FILES,
  memorySlug,
  replaceMemoryBody,
  scanMemoryDir,
  scanMemoryDrafts,
  type MemoryFileRow
} from './memory'
import type { MemoryLandResult, MemoryWriteOp } from './memory-writes'
import { resolveBrainProject, type BrainProject } from './project'
import { freshestBySlug } from './serve'
import { BrainStore, brainDbPath } from './store'
import type { BrainLandResult, BrainSpliceResult } from './writes'
import type { BrainLibDocDbRow } from './store'
import type { BrainBuildOutcome, BrainDeltaOutcome, BrainLibrariesOutcome, BrainWorkerReply } from './indexer-worker'

export { resolveBrainProject, type BrainProject } from './project'
export { BrainStore, brainDbPath, BRAIN_SCHEMA_VERSION } from './store'
export type { BrainBuildOutcome, BrainDeltaOutcome, BrainLibrariesOutcome } from './indexer-worker'
export type { BrainLibDocDbRow, BrainLibDepDbRow, BrainLibListDbRow } from './store'
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
  BRAIN_WRITE_VERBS,
  isBrainWriteVerb,
  serveBrainWrite,
  type BrainLandResult,
  type BrainSpliceResult,
  type BrainWriteHost
} from './writes'
export {
  MEMORY_WRITE_VERBS,
  isMemoryWriteVerb,
  serveMemoryWrite,
  type BrainMemoryWriteHost,
  type MemoryLandResult,
  type MemoryWriteOp
} from './memory-writes'
export {
  MEMORY_DIR,
  MEMORY_DRAFTS_DIRNAME,
  MEMORY_MAX_FILES,
  MEMORY_MAX_FILE_BYTES,
  MEMORY_SUGGEST_WEIGHTS,
  MEMORY_FILTER_MAX_CLAUSES,
  MEMORY_MAX_PROPS,
  MEMORY_PROP_VALUE_MAX,
  MEMORY_RESERVED_KEYS,
  isMemorySlug,
  memorySlug,
  memoryLinksOf,
  parseMemoryFilter,
  parseMemoryText,
  scanMemoryDir,
  scanMemoryDrafts,
  serializeMemory,
  type MemoryFileRow,
  type MemoryFilterClause,
  type MemoryScan
} from './memory'
export {
  CAPTURE_MAX_BLOCKS,
  CAPTURE_MAX_FILES,
  CAPTURE_MAX_SYMBOLS,
  CAPTURE_MIN_COMMANDS,
  buildCardDraft,
  buildMergeDraft,
  buildSessionDraft,
  captureCommandLine,
  serializeDraft,
  type CaptureBlock,
  type CaptureDraft,
  type CardFacts,
  type DraftDistillation,
  type MergeFacts
} from './capture'
export {
  distillAttemptsForSmoke,
  distillDraft,
  distillHttpAttemptsForSmoke,
  fakeDistillText,
  type DistillInput,
  type DistillResult,
  type DistillTarget
} from './distill'
export {
  BRAIN_SERVE_DEFAULT_LIMIT,
  BRAIN_SERVE_MAX_LIMIT,
  BRAIN_SERVE_DEFAULT_DEPTH,
  BRAIN_SERVE_MAX_DEPTH,
  BRAIN_SERVE_RESPONSE_CAP,
  freshestBySlug,
  globToLike,
  partitionOf,
  serveBrainRead,
  serveMemorySearchSemantic,
  type BrainReadHost,
  type BrainServeReply,
  type MemorySemanticLens
} from './serve'
export {
  EMBED_FAKE_ENDPOINT,
  EMBED_QUERY_MAX_CHARS,
  armEmbedFailureForSmoke,
  embedHttpAttemptsForSmoke,
  embedProviderLabel,
  embedTexts,
  isEmbedEndpoint,
  type EmbedTarget
} from './embed'
export {
  MEMORY_RECALL_BACKLINK_CAP,
  MEMORY_RECALL_WEIGHTS,
  memoryRecallExpr,
  recallTaskTerms,
  serveBrainRecall
} from './recall'

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

/** What one embed pass runs under (ADR 0018 revision A) — resolved by MAIN per
 *  project at pass time: the consenting workspace's OWN endpoint + model, its
 *  vault-resolved key (in memory only), and the single-fire failure surface.
 *  Null = no consenting workspace stands in this project; the pass is a no-op
 *  and the deterministic lenses never notice. */
export interface BrainMemoryEmbedPlan {
  endpoint: string
  model: string
  key: string | null
  onFailure: (detail: string) => void
}
export type BrainMemoryEmbedPlanner = (projectRoots: string[]) => BrainMemoryEmbedPlan | null

// ── Draft retention caps (ADR 0018 revision C) ───────────────────────────────
// Contract defaults with a SMOKE-ONLY override (the embed-fault pattern:
// production never arms it, a gate may — proving eviction without landing two
// hundred drafts).
let draftCapOverride: { maxDrafts?: number; maxAgeDays?: number } = {}
export function setDraftCapsForSmoke(caps: { maxDrafts?: number; maxAgeDays?: number }): void {
  draftCapOverride = caps
}
const draftCaps = (): { maxDrafts: number; maxAgeDays: number } => ({
  maxDrafts: draftCapOverride.maxDrafts ?? BRAIN_MAX_DRAFTS,
  maxAgeDays: draftCapOverride.maxAgeDays ?? BRAIN_DRAFT_MAX_AGE_DAYS
})

/** A scanned draft file → its store row: provenance (`source`, `distilled`)
 *  reads off the file's OWN props — the file stays the truth. */
const draftRowOf = (row: MemoryFileRow): { slug: string; name: string; description: string; tags: string[]; source: string; distilled: boolean; body: string; hash: string; mtime: number; bytes: number } => ({
  slug: row.slug,
  name: row.name,
  description: row.description,
  tags: row.tags,
  source: row.props.source === 'session' || row.props.source === 'merge' || row.props.source === 'card' ? row.props.source : '',
  distilled: row.props.distilled === 'true',
  body: row.body,
  hash: row.hash,
  mtime: row.mtime,
  bytes: row.bytes
})

export class BrainService {
  /** Insertion-ordered: the Map IS the LRU (delete + re-set marks recency). */
  private readonly open = new Map<string, OpenBrain>()
  /** Folded projectKeys with a build in flight — the `busy` refusal's whole truth. */
  private readonly building = new Set<string>()
  /** Per-project serialization: drains and rebuilds queue, never interleave (04). */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Bumped per landed rebuild — a drain that queued behind one drops its stale slice. */
  private readonly rebuildSeq = new Map<string, number>()
  /** Per-root debounce for lockfile-triggered library resolves (08). */
  private readonly libTimers = new Map<string, NodeJS.Timeout>()
  /** Landed library resolves — the BRAINDOCS smoke's progress witness. */
  private libResolveCount = 0
  /** Per-root debounce for routed `.memory/` rescans (09). */
  private readonly memTimers = new Map<string, NodeJS.Timeout>()
  /** Landed memory rescans — the MEMGRAPH smoke's progress witness. */
  private memRescanCount = 0
  /** Revision A: the semantic lens's embed pass — debounced per root, single
   *  flight per project, and OFF entirely until main hands in a planner. */
  private embedPlanner: BrainMemoryEmbedPlanner | null = null
  private readonly embedTimers = new Map<string, NodeJS.Timeout>()
  private readonly embedInFlight = new Set<string>()
  private readonly embedPending = new Set<string>()
  private memEmbedPerformed = 0
  private memEmbedSkipped = 0
  private memEmbedFailures = 0
  private memEmbedPasses = 0
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
    // 08: a lockfile landing in a drain re-resolves the LIBRARY truth too — the
    // freshness layer routes the paths, this schedules the (debounced) resolve.
    this.freshness.onLockfilePaths((root) => this.scheduleLibraryResolve(root))
    // 09: `.memory/` traffic routes here and NEVER into the dirty set — the
    // memory indexer is its own (cheap, main-thread) rescan of the flat dir.
    this.freshness.onMemoryPaths((root) => this.scheduleMemoryRescan(root))
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
        // 08: the library truth rides every full build — a refused resolve costs the
        // libraries lens, never the graph (the status answer stays the build's).
        const lib = await this.runLibraries(partitionRoot, r.brain.project)
        if (!('reason' in lib)) this.libResolveCount += 1
        // 09: so does the memory lens — a rebuild restores search from the files
        // alone, which is what makes the brain db honestly disposable.
        this.rescanMemories(partitionRoot)
        return this.answer(r.brain)
      })
    } finally {
      this.building.delete(key)
    }
  }

  /**
   * The ONE write door (ADR 0018 step 07): land a symbol write on `rel` under
   * `root`'s partition — CAS-guarded, atomic, synchronously re-indexed. Runs the
   * whole check-splice-write-reindex sequence inside the project's exclusive
   * queue, so it never interleaves with a drain or a rebuild, and the hash it
   * checks is the hash it writes over. Two hashes must BOTH match the expected:
   * the disk's (the caller's claim of what it read) and the index's (the line
   * range's provenance) — either off is a `stale` refusal carrying the fresh
   * disk hash, and the disk is untouched. After write-file-atomic lands the
   * bytes, THAT file is re-indexed in the worker before the answer: the reply's
   * generation is the new one, and the caller's next query is already true.
   */
  async landSymbolWrite(
    root: string,
    rel: string,
    expectedFileHash: string,
    splice: (current: Buffer) => BrainSpliceResult
  ): Promise<BrainLandResult> {
    const pre = this.ensure(root)
    if ('reason' in pre) return { ok: false, reason: pre.reason, ...(pre.detail ? { detail: pre.detail } : {}) }
    const key = foldProjectKey(pre.brain.project.projectKey)
    return this.runExclusive(key, async (): Promise<BrainLandResult> => {
      const r = this.ensure(root) // the LRU may have moved under the queue
      if ('reason' in r) return { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) }
      const partitionRoot = this.partitionRootFor(r.brain.project, root)
      const abs = path.join(partitionRoot, rel)
      let current: Buffer
      try {
        current = readFileSync(abs)
      } catch {
        return { ok: false, reason: 'missing', detail: 'the file does not exist on disk — re-query the node' }
      }
      const diskHash = createHash('sha256').update(current).digest('hex')
      if (diskHash !== expectedFileHash) {
        return {
          ok: false,
          reason: 'stale',
          freshHash: diskHash,
          detail: 'the file changed since your expectedFileHash — re-query the node and retry against current lines'
        }
      }
      const dbRow = r.brain.store.fileRow(partitionRoot, rel)
      if (!dbRow || dbRow.hash !== diskHash) {
        // The caller's claim matches the DISK but the INDEX has not absorbed these
        // bytes yet — the node's line range describes older bytes, and splicing by
        // it would land blind. Same refusal register; the fix is a short re-query.
        return {
          ok: false,
          reason: 'stale',
          freshHash: diskHash,
          detail: 'the index has not absorbed this file\'s current bytes yet — re-query shortly and retry'
        }
      }
      const spliced = splice(current)
      if ('reason' in spliced) {
        return { ok: false, reason: spliced.reason, ...(spliced.detail ? { detail: spliced.detail } : {}) }
      }
      try {
        // Atomic or refused: temp file + fsync + rename (write-file-atomic). A crash
        // on any path leaves the old bytes whole or the new bytes whole, never a mix.
        writeFileAtomic.sync(abs, spliced.next)
      } catch (e) {
        return { ok: false, reason: 'busy', detail: 'the write could not land: ' + (e instanceof Error ? e.message : String(e)) }
      }
      const newFileHash = createHash('sha256').update(spliced.next).digest('hex')
      const outcome = await this.runDelta(partitionRoot, r.brain.project, {
        changed: [rel],
        deleted: [],
        reconcile: false
      })
      if ('reason' in outcome) {
        // The bytes LANDED; only the re-index refused. Saying "refused" without
        // `landed` would be a lie the agent acts on. Freshness is deliberately NOT
        // absorbed here, so the next tick sees the un-absorbed mtime and heals.
        return {
          ok: false,
          reason: 'busy',
          landed: true,
          detail: 'the edit landed on disk, but the re-index failed — the index will catch up; re-query before further edits'
        }
      }
      // The landing is absorbed truth, not dirt — and the UI learns the graph moved
      // (the drain path's one-emission shape, without touching its counters).
      this.freshness?.absorb(partitionRoot, outcome.records, outcome.removed)
      const dirty = r.brain.project.roots.some((rt) => (this.freshness?.dirtyCount(rt) ?? 0) > 0)
      this.changedCb?.({ projectKey: r.brain.project.projectKey, generation: outcome.generation, dirty })
      return { ok: true, generation: outcome.generation, newFileHash }
    })
  }

  /**
   * The ONE memory-write door (ADR 0018 step 09): land a create/update on the
   * caller's own `.memory/` — CAS-guarded (update), atomic, synchronously
   * re-scanned. Runs inside the project's exclusive queue, so it never
   * interleaves with a drain, a rebuild, or another memory write. The slug law
   * (kebab-case only, enforced at the serve layer) is what makes any path
   * outside `<checkout>/.memory/` unspellable here.
   */
  async landMemoryWrite(root: string, op: MemoryWriteOp): Promise<MemoryLandResult> {
    const pre = this.ensure(root)
    if ('reason' in pre) return { ok: false, reason: pre.reason, ...(pre.detail ? { detail: pre.detail } : {}) }
    const key = foldProjectKey(pre.brain.project.projectKey)
    return this.runExclusive(key, async (): Promise<MemoryLandResult> => {
      const r = this.ensure(root) // the LRU may have moved under the queue
      if ('reason' in r) return { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) }
      const partitionRoot = this.partitionRootFor(r.brain.project, root)
      const dir = path.join(partitionRoot, MEMORY_DIR)
      const abs = path.join(dir, `${op.slug}.md`)

      // The draft verbs (revision C): move OR delete inside the quarantine —
      // never a byte rewritten. Draftness is a FILE fact (which dir holds the
      // slug), so the engine cannot be argued into deleting a curated memory.
      if (op.kind === 'promote' || op.kind === 'discard') {
        const draftAbs = path.join(dir, MEMORY_DRAFTS_DIRNAME, `${op.slug}.md`)
        if (!existsSync(draftAbs)) {
          if (op.kind === 'discard' && existsSync(abs)) {
            return {
              ok: false,
              reason: 'invalid',
              detail: `"${op.slug}" is a promoted memory, not a draft — promoted memories are permanent here; removing one is a human's git rm`
            }
          }
          return {
            ok: false,
            reason: 'unknown-memory',
            detail: `no draft "${op.slug}" in this checkout's .memory/drafts/ — search_memories flags draft hits with draft:true`
          }
        }
        if (op.kind === 'promote' && existsSync(abs)) {
          return {
            ok: false,
            reason: 'exists',
            detail: `a memory "${op.slug}" already exists in .memory/ — discard the draft, or update_memory the memory`
          }
        }
        try {
          if (op.kind === 'promote') renameSync(draftAbs, abs)
          else rmSync(draftAbs)
        } catch (e) {
          return { ok: false, reason: 'busy', detail: 'the landing could not move: ' + (e instanceof Error ? e.message : String(e)) }
        }
        this.rescanMemories(partitionRoot)
        const fileHash =
          op.kind === 'promote' ? createHash('sha256').update(readFileSync(abs)).digest('hex') : ''
        return { ok: true, slug: op.slug, fileHash }
      }

      let next: string
      if (op.kind === 'create') {
        if (existsSync(abs)) {
          return {
            ok: false,
            reason: 'exists',
            detail: `memory "${op.slug}" already exists — update_memory edits it (get_memory answers its fileHash)`
          }
        }
        next = op.text
      } else {
        let current: Buffer
        try {
          current = readFileSync(abs)
        } catch {
          return {
            ok: false,
            reason: 'unknown-memory',
            detail: `no memory "${op.slug}" in this checkout's .memory/ — create_memory writes new ones`
          }
        }
        const diskHash = createHash('sha256').update(current).digest('hex')
        if (diskHash !== op.expectedFileHash) {
          return {
            ok: false,
            reason: 'stale',
            freshHash: diskHash,
            detail: 'the memory changed since your expectedFileHash — re-read it (get_memory) and retry against current bytes'
          }
        }
        const spliced = replaceMemoryBody(current.toString('utf8'), op.body)
        if (spliced === null) {
          return { ok: false, reason: 'invalid', detail: 'the file on disk has no readable frontmatter — fix it by hand; update_memory only swaps bodies' }
        }
        next = spliced
      }
      try {
        mkdirSync(dir, { recursive: true })
        // Atomic or refused (write-file-atomic): the old bytes whole or the new
        // bytes whole, never a mix — the symbol-write law, for memories.
        writeFileAtomic.sync(abs, next)
      } catch (e) {
        return { ok: false, reason: 'busy', detail: 'the write could not land: ' + (e instanceof Error ? e.message : String(e)) }
      }
      // Synchronous re-scan: the caller's next search/get already serves this.
      this.rescanMemories(partitionRoot)
      return { ok: true, slug: op.slug, fileHash: createHash('sha256').update(next, 'utf8').digest('hex') }
    })
  }

  /**
   * Land ONE auto-captured draft in `root`'s quarantine (ADR 0018 revision C):
   * dedupe the slug against BOTH dirs (a draft never shadows a curated slug),
   * write atomically, run retention (max age first, then oldest-out past the
   * cap — every eviction counted, never silent), and rescan so the caller's
   * next read is already true. Retention touches ONLY `.memory/drafts/` by
   * construction — no auto-delete path for a promoted memory EXISTS.
   */
  async landMemoryDraft(root: string, draft: CaptureDraft, distilled?: DraftDistillation): Promise<{ ok: true; slug: string } | { ok: false; reason: string; detail?: string }> {
    const pre = this.ensure(root)
    if ('reason' in pre) return { ok: false, reason: pre.reason, ...(pre.detail ? { detail: pre.detail } : {}) }
    const key = foldProjectKey(pre.brain.project.projectKey)
    return this.runExclusive(key, async (): Promise<{ ok: true; slug: string } | { ok: false; reason: string; detail?: string }> => {
      const r = this.ensure(root)
      if ('reason' in r) return { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) }
      const partitionRoot = this.partitionRootFor(r.brain.project, root)
      const memDir = path.join(partitionRoot, MEMORY_DIR)
      const draftsDir = path.join(memDir, MEMORY_DRAFTS_DIRNAME)
      const base = memorySlug(draft.slugBase)
      if (!base) return { ok: false, reason: 'invalid', detail: 'the draft has no sluggable name' }
      let slug: string | null = null
      for (let i = 1; i <= 99; i++) {
        const candidate = i === 1 ? base : memorySlug(`${base}-${i}`)
        if (!candidate) break
        if (!existsSync(path.join(draftsDir, `${candidate}.md`)) && !existsSync(path.join(memDir, `${candidate}.md`))) {
          slug = candidate
          break
        }
      }
      if (!slug) return { ok: false, reason: 'exists', detail: 'no free slug within the collision window' }
      try {
        mkdirSync(draftsDir, { recursive: true })
        // The quarantine is GIT-INVISIBLE by construction (the `.mogging/`
        // gitignore precedent): a draft joins git only by promotion, and an
        // untracked draft must never dirty the repo — the review merge gate
        // (clean-repo law) would refuse every later merge otherwise. Written
        // once, self-ignoring, and NEVER overwritten: an existing ignore file
        // is the user's configuration, theirs to own.
        const ignoreFile = path.join(memDir, '.gitignore')
        if (!existsSync(ignoreFile)) {
          writeFileAtomic.sync(
            ignoreFile,
            '# MoggingLabs Workspace: the draft quarantine joins git only by promotion.\ndrafts/\n.gitignore\n'
          )
        }
        writeFileAtomic.sync(path.join(draftsDir, `${slug}.md`), serializeDraft(slug, draft, distilled))
      } catch (e) {
        return { ok: false, reason: 'busy', detail: 'the draft could not land: ' + (e instanceof Error ? e.message : String(e)) }
      }
      this.enforceDraftRetention(r.brain.store, partitionRoot, draftsDir)
      this.rescanMemories(partitionRoot)
      return { ok: true, slug }
    })
  }

  /** Retention: expired drafts first (max age), then oldest-out past the cap.
   *  Deterministic order (mtime, then slug); each deletion is COUNTED. */
  private enforceDraftRetention(store: BrainStore, partitionRoot: string, draftsDir: string): void {
    const caps = draftCaps()
    const rows = scanMemoryDrafts(partitionRoot).rows
      .map((row) => ({ slug: row.slug, mtime: row.mtime }))
      .sort((a, b) => a.mtime - b.mtime || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    const cutoff = Date.now() - caps.maxAgeDays * 86_400_000
    const doomed = new Set<string>()
    for (const row of rows) if (row.mtime < cutoff) doomed.add(row.slug)
    const remaining = rows.filter((row) => !doomed.has(row.slug))
    for (const row of remaining.slice(0, Math.max(0, remaining.length - caps.maxDrafts))) doomed.add(row.slug)
    let evicted = 0
    for (const slug of doomed) {
      try {
        rmSync(path.join(draftsDir, `${slug}.md`))
        evicted += 1
      } catch {
        /* a held file survives one round; the next landing retries */
      }
    }
    try {
      store.bumpDraftEvictions(partitionRoot, evicted)
    } catch {
      /* the count heals nothing but honesty; a locked store loses one bump */
    }
  }

  /** Rescan ONE partition's `.memory/` into the store — the whole memory
   *  indexer (flat dir, small files, main-thread by design; the worker never
   *  learns about memories). Generation-neutral, like the library lens. */
  private rescanMemories(partitionRoot: string): void {
    const r = this.ensure(partitionRoot)
    if ('reason' in r) return
    try {
      const scan = scanMemoryDir(partitionRoot)
      // Revision C: the quarantine scans in the SAME pass — its rows land in
      // their own tables (drafts can never leak into suggestions or recall by
      // construction), and its skips fold into the ONE honest skip account.
      const draftScan = scanMemoryDrafts(partitionRoot)
      const skipped = {
        invalid: scan.skipped.invalid + draftScan.skipped.invalid,
        tooLarge: scan.skipped.tooLarge + draftScan.skipped.tooLarge,
        foreign: scan.skipped.foreign + draftScan.skipped.foreign
      }
      const capped = scan.capped || draftScan.capped
      // An uncommitted memory file is re-announced by porcelain EVERY tick;
      // identical bytes must not re-land (the standing-dirty-repo rule). The
      // baseline is what the STORE holds — never a process-memory cache that
      // could survive a db delete and lie about it. The fingerprint carries
      // the SKIP COUNTS too (revision B): a newly-appeared foreign or invalid
      // file changes no row, and rows alone would never land it. Draft rows
      // ride the same fingerprint (revision C) under their own marker.
      const skipsOf = (s: { invalid: number; tooLarge: number; foreign: number }, c: boolean): string =>
        `#skips ${s.invalid}/${s.tooLarge}/${s.foreign}/${c ? 1 : 0}`
      const fingerprint =
        scan.rows.map((row) => `${row.slug}:${row.hash}`).join('\n') +
        '\n#drafts\n' +
        draftScan.rows.map((row) => `${row.slug}:${row.hash}`).join('\n') +
        '\n' +
        skipsOf(skipped, capped)
      const heldScan = r.brain.store.memoryScan(partitionRoot)
      const held =
        r.brain.store
          .memoriesForRoots([partitionRoot])
          .map((row) => `${row.slug}:${row.hash}`)
          .join('\n') +
        '\n#drafts\n' +
        r.brain.store
          .memoryDraftsForRoots([partitionRoot])
          .map((row) => `${row.slug}:${row.hash}`)
          .join('\n') +
        '\n' +
        (heldScan ? skipsOf(heldScan, heldScan.capped) : '#skips never-landed')
      if (fingerprint !== held) {
        r.brain.store.replaceMemories(partitionRoot, scan.rows, scan.links, skipped, capped)
        r.brain.store.replaceMemoryDrafts(partitionRoot, draftScan.rows.map(draftRowOf))
        this.memRescanCount += 1
      }
      // Revision A: EVERY drain offers the embed pass — even a no-change rescan
      // (a model swap or a fresh consent has work the fingerprint cannot see).
      // The pass itself is content-hash keyed, so offering it is nearly free.
      this.scheduleMemoryEmbed(partitionRoot)
    } catch {
      /* a locked store loses one rescan; the next routed change retries */
    }
  }

  /** Hand in (or clear) the semantic lens's planner (ADR 0018 revision A).
   *  Without one — consent OFF everywhere, or a build that never wires it —
   *  no embed pass ever runs and no vector is ever read or written. */
  setMemoryEmbedPlanner(planner: BrainMemoryEmbedPlanner | null): void {
    this.embedPlanner = planner
  }

  /** Nudge the embed pass for the project `root` stands in — the consent/config
   *  flip's door (turning the lens ON should not wait for the next edit). */
  pokeMemoryEmbed(root: string): void {
    this.scheduleMemoryEmbed(path.resolve(root))
  }

  /** The embed pass's counters — the BRAINSEM smoke's witnesses. */
  memoryEmbedStats(): { performed: number; skipped: number; failures: number; passes: number } {
    return {
      performed: this.memEmbedPerformed,
      skipped: this.memEmbedSkipped,
      failures: this.memEmbedFailures,
      passes: this.memEmbedPasses
    }
  }

  private scheduleMemoryEmbed(root: string): void {
    if (!this.embedPlanner) return
    const key = foldProjectKey(root)
    const prior = this.embedTimers.get(key)
    if (prior) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.embedTimers.delete(key)
      void this.runMemoryEmbedPass(root)
    }, 300)
    timer.unref?.()
    this.embedTimers.set(key, timer)
  }

  /**
   * One embed pass over the PROJECT's freshest copies (the same election every
   * read serves): content-hash keyed — an unchanged memory under an unchanged
   * model never re-embeds (counted as a skip); a changed hash or a swapped
   * model replaces the row in place. Runs OUTSIDE the exclusive queue on
   * purpose (HTTP must not dam writes); a rescan landing mid-pass just makes
   * the landed hash stale, and the next drain heals it — the key makes stale
   * landings self-correcting. One failure aborts the pass, counts, and fires
   * the plan's failure surface; nothing retries in a loop.
   */
  private async runMemoryEmbedPass(root: string): Promise<void> {
    const planner = this.embedPlanner
    if (!planner) return
    const pre = this.ensure(root)
    if ('reason' in pre) return
    const project = pre.brain.project
    const key = foldProjectKey(project.projectKey)
    if (this.embedInFlight.has(key)) {
      this.embedPending.add(key)
      return
    }
    this.embedInFlight.add(key)
    try {
      const plan = planner([...project.roots])
      if (!plan) return
      const store = pre.brain.store
      const written = freshestBySlug(store.memoriesForRoots([...project.roots]), project.roots)
      // The row cap is the memory dir's own cap — past it nothing embeds silently
      // wrong; the slugs are sorted so the kept set is stable.
      const slugs = [...written.keys()].sort().slice(0, MEMORY_MAX_FILES)
      const meta = new Map(store.memoryVectorMeta().map((m) => [m.slug, m]))
      const toEmbed: { slug: string; hash: string; text: string }[] = []
      let skipped = 0
      for (const slug of slugs) {
        const fresh = written.get(slug)
        if (!fresh) continue
        const held = meta.get(slug)
        if (held && held.contentHash === fresh.hash && held.model === plan.model) {
          skipped += 1
          continue
        }
        const copy = store.memoryCopies([fresh.root], slug)[0]
        if (!copy) continue
        toEmbed.push({ slug, hash: copy.hash, text: embedTextOfMemory(copy) })
      }
      this.memEmbedSkipped += skipped
      const target: EmbedTarget = { endpoint: plan.endpoint, model: plan.model, key: plan.key }
      for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
        const batch = toEmbed.slice(i, i + EMBED_BATCH)
        const res = await embedTexts(target, batch.map((b) => b.text))
        if (!res.ok) {
          this.memEmbedFailures += 1
          plan.onFailure(res.detail)
          return
        }
        try {
          for (let j = 0; j < batch.length; j++) {
            store.putMemoryVector(batch[j].slug, batch[j].hash, plan.model, res.dim, vectorToBlob(res.vectors[j]))
          }
        } catch {
          return // the LRU may have closed the handle mid-pass; the next drain retries
        }
        this.memEmbedPerformed += batch.length
      }
      try {
        store.pruneMemoryVectors(slugs)
      } catch {
        /* same: a lost prune re-runs next pass */
      }
      this.memEmbedPasses += 1
    } finally {
      this.embedInFlight.delete(key)
      if (this.embedPending.delete(key)) void this.runMemoryEmbedPass(root)
    }
  }

  /** Debounced routed-path rescan (09): one timer per root, the rescan queued
   *  behind whatever the project is doing — never concurrent with a landing. */
  private scheduleMemoryRescan(root: string): void {
    const key = foldProjectKey(root)
    const prior = this.memTimers.get(key)
    if (prior) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.memTimers.delete(key)
      const pre = this.ensure(root)
      if ('reason' in pre) return
      const pKey = foldProjectKey(pre.brain.project.projectKey)
      void this.runExclusive(pKey, async () => {
        this.rescanMemories(this.partitionRootFor(pre.brain.project, root))
      })
    }, 300)
    timer.unref?.()
    this.memTimers.set(key, timer)
  }

  /** Landed memory rescans so far — the MEMGRAPH smoke's progress witness. */
  memoryRescans(): number {
    return this.memRescanCount
  }

  /** Debounced lockfile-triggered library re-resolve (08): one timer per root,
   *  the resolve itself queued behind whatever the project is doing. */
  private scheduleLibraryResolve(root: string): void {
    const key = foldProjectKey(root)
    const prior = this.libTimers.get(key)
    if (prior) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.libTimers.delete(key)
      const pre = this.ensure(root)
      if ('reason' in pre) return
      const pKey = foldProjectKey(pre.brain.project.projectKey)
      void this.runExclusive(pKey, async () => {
        const r = this.ensure(root)
        if ('reason' in r) return
        const partitionRoot = this.partitionRootFor(r.brain.project, root)
        const lib = await this.runLibraries(partitionRoot, r.brain.project)
        if (!('reason' in lib)) this.libResolveCount += 1
      })
    }, 1000)
    timer.unref?.()
    this.libTimers.set(key, timer)
  }

  /** Landed library resolves so far — the BRAINDOCS smoke's progress witness. */
  libraryResolves(): number {
    return this.libResolveCount
  }

  /** Land ONE fetched doc row (the consent-gated registry path, main-side).
   *  The row's version is the pinned version the fetch was locked to, so the
   *  next resolve's prune keeps it exactly as long as a lockfile references it. */
  landLibraryDoc(root: string, row: BrainLibDocDbRow): boolean {
    const r = this.ensure(root)
    if ('reason' in r) return false
    try {
      r.brain.store.libDocPut(row)
      return true
    } catch {
      return false
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
    for (const timer of this.libTimers.values()) clearTimeout(timer)
    this.libTimers.clear()
    for (const timer of this.memTimers.values()) clearTimeout(timer)
    this.memTimers.clear()
    for (const timer of this.embedTimers.values()) clearTimeout(timer)
    this.embedTimers.clear()
    this.embedPending.clear()
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
    // 09: the cold-start heal covers memories too — `.memory/` may have moved
    // while the app was closed, and no porcelain tick will re-announce it.
    if (reconcile) this.scheduleMemoryRescan(root)
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

  /** 08: the library resolve, in the worker (lockfile parse + disk-docs distill
   *  + one store transaction). Same spawn discipline as build/delta. */
  private runLibraries(
    partitionRoot: string,
    project: BrainProject
  ): Promise<BrainLibrariesOutcome | BrainRefusal> {
    const dbPath = brainDbPath(this.opts.baseDir, project.projectKey)
    return new Promise((resolve) => {
      const worker = new Worker(this.opts.workerFile, {
        workerData: { grammarsDir: this.opts.grammarsDir }
      })
      const finish = (value: BrainLibrariesOutcome | BrainRefusal): void => {
        void worker.terminate()
        resolve(value)
      }
      worker.on('message', (reply: BrainWorkerReply) => {
        if ('libraries' in reply) finish(reply.libraries)
        else if ('error' in reply) finish({ ok: false, reason: 'busy', detail: reply.error })
      })
      worker.on('error', (e) => finish({ ok: false, reason: 'busy', detail: String(e) }))
      worker.postMessage({ id: 1, op: 'libraries', dbPath, root: partitionRoot })
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
