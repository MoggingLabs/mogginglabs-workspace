import { statSync } from 'node:fs'
import * as path from 'node:path'
import { foldProjectKey } from '../workspace/project-identity'
import { diffHeadMove } from './head'
import catalogJson from './grammars.json'
import type { BrainDeltaOutcome } from './indexer-worker'

// The freshness law (ADR 0018, step 04): the brain FOLLOWS the repo it extracts knowledge
// from — event-driven, incremental, honest. No cron, no full rebuilds on a timer, no silent
// staleness. This module is the whole answer to "how does it stay up to date": it RIDES the
// one 2.5s GitMonitor porcelain tick the panes and the explorer already pay for (the docs/05
// law — zero new pollers, zero recursive watchers), turns each tick's parsed batch into a
// per-root DIRTY SET by stat-compare against what the index last applied, and drains that
// set through the worker's incremental verbs — debounced, slice-capped, one transaction and
// ONE generation bump per drain. Staleness is DATA (`dirty` on every answer), never a
// blocking wait; coalesce or refuse — a write storm may never produce a drain storm.
//
// Non-repo roots have no porcelain to ride, so they get the bare cadence beat instead: a
// CAPPED mtime sweep of the files the index already knows, rotated slice by slice and
// jittered per root — no new watcher machinery, and new-file discovery stays the explicit
// rebuild's job (folder mode is the degraded citizen on purpose).
//
// Electron-free, worker-free: this thread only ever stats and bookkeeps. The parse muscle
// stays in the indexer worker; the service (index.ts) owns spawning it and hands `deps.apply`
// down here.

/** Quiet time after the last dirt lands before a drain runs — the coalescing window. */
export const BRAIN_DRAIN_QUIET_MS = 750
/** A drain never exceeds this many paths; larger spills roll into the next drain with
 *  `dirty` still counted — honesty over heroics. */
export const BRAIN_DRAIN_SLICE = 200
/** Non-repo mtime sweep: how many known files one cadence beat may stat. */
export const BRAIN_SWEEP_SLICE = 250
/** Spill continuation / deferred-drain retry delays. */
const SPILL_MS = 250
const RETRY_MS = 2_500
const MAX_CONSECUTIVE_FAILURES = 5

/** The catalog's whole routing truth, as data: an extension outside this set can never
 *  become a row, so a change to it is not the index's business (same json the worker's
 *  ParserPool routes by — one source, two readers). */
const INDEXABLE_EXTS = new Set(
  (catalogJson as { grammars: { extensions: string[] }[] }).grammars.flatMap((g) =>
    g.extensions.map((e) => e.toLowerCase())
  )
)
const indexableExt = (rel: string): boolean => INDEXABLE_EXTS.has(path.extname(rel).toLowerCase())

/** Lockfiles route to their own subscribers (09 attaches) — and STILL dirty the index,
 *  because the walk indexes them (they are tracked source-adjacent files). */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock'
])
const isLockfile = (rel: string): boolean =>
  LOCKFILE_NAMES.has(rel.slice(rel.lastIndexOf('/') + 1).toLowerCase())

/** The structural subset of the monitor's tick payload the brain needs — declared here so
 *  @backend/brain depends on the git feature's SHAPE, not its module graph. */
export interface BrainTickPayload {
  root: string
  status: { head: string | null; available: boolean } | null
  files: { path: string; state: string }[] | null
  truncated: boolean
}

export interface BrainTickSource {
  subscribeTick(root: string, sub: (p: BrainTickPayload) => void): () => void
}

/** One drain's worth of work, as the worker sees it. `reconcile: true` means "trust the
 *  walk, not these lists" — cold starts, truncated batches, untracked directories. */
export interface BrainDeltaRequest {
  changed: string[]
  deleted: string[]
  reconcile: boolean
}

export interface BrainFreshnessDeps {
  /** Serialize + run the incremental worker op. Null = refused/deferred; the dirt stays. */
  apply(root: string, req: BrainDeltaRequest): Promise<BrainDeltaOutcome | null>
  /** A drain COMMITTED (one gen bump) — the service's one `brain:changed` per drain. */
  applied?(root: string, outcome: BrainDeltaOutcome): void
}

/** The BRAINFRESH smoke's witness surface — counters, never behavior. */
export interface BrainFreshnessStats {
  attached: boolean
  isRepo: boolean
  ticks: number
  dirty: number
  deleted: number
  needsReconcile: boolean
  draining: boolean
  drains: number
  noopDrains: number
  reconciles: number
  headMoves: number
  sweeps: number
  lastProcessed: number
  lastRemoved: number
  lastCacheHits: number
  lastCacheMisses: number
}

interface AppliedRec {
  mtime: number
  bytes: number
}

interface RootState {
  root: string
  unsubscribe: () => void
  /** path -> stat at the moment the index (or a drain) resolved it. The stat-compare base. */
  applied: Map<string, AppliedRec>
  dirty: Set<string>
  deleted: Set<string>
  needsReconcile: boolean
  /** Last tick's porcelain paths (non-deleted) — departures mean commit/revert, stat once. */
  prevBatch: Set<string>
  head: string | null
  isRepo: boolean
  timer: NodeJS.Timeout | null
  draining: boolean
  pending: boolean
  failures: number
  sweepCursor: number
  stats: Omit<BrainFreshnessStats, 'attached' | 'isRepo' | 'dirty' | 'deleted' | 'needsReconcile' | 'draining'>
}

const freshStats = (): RootState['stats'] => ({
  ticks: 0,
  drains: 0,
  noopDrains: 0,
  reconciles: 0,
  headMoves: 0,
  sweeps: 0,
  lastProcessed: 0,
  lastRemoved: 0,
  lastCacheHits: 0,
  lastCacheMisses: 0
})

/** Deterministic per-root sweep offset — several folder roots must not stat in lockstep. */
const jitterOf = (root: string, len: number): number => {
  let h = 2166136261
  for (let i = 0; i < root.length; i++) h = Math.imul(h ^ root.charCodeAt(i), 16777619)
  return len > 0 ? (h >>> 0) % len : 0
}

export class BrainFreshness {
  private readonly roots = new Map<string, RootState>()
  private readonly memorySubs = new Set<(root: string, paths: string[]) => void>()
  private readonly lockSubs = new Set<(root: string, paths: string[]) => void>()

  constructor(
    private readonly source: BrainTickSource,
    private readonly deps: BrainFreshnessDeps
  ) {}

  /** `.memory/` traffic routes HERE and never into the dirty set (the walk excludes it —
   *  a row for it would be drift). The service (09) attaches its memory rescan. */
  onMemoryPaths(cb: (root: string, paths: string[]) => void): () => void {
    this.memorySubs.add(cb)
    return () => this.memorySubs.delete(cb)
  }

  /** Lockfile traffic, announced ALONGSIDE normal dirtying. 09 attaches. */
  onLockfilePaths(cb: (root: string, paths: string[]) => void): () => void {
    this.lockSubs.add(cb)
    return () => this.lockSubs.delete(cb)
  }

  /** Start following a root whose partition exists. `reconcile` = the cold-start heal:
   *  the app may have been closed while files changed, so the first drain trusts the walk. */
  attach(root: string, seed: { path: string; mtime: number; bytes: number }[], reconcile: boolean): void {
    const key = foldProjectKey(root)
    if (this.roots.has(key)) return
    const state: RootState = {
      root,
      unsubscribe: () => undefined,
      applied: new Map(seed.map((r) => [r.path, { mtime: r.mtime, bytes: r.bytes }])),
      dirty: new Set(),
      deleted: new Set(),
      needsReconcile: false,
      prevBatch: new Set(),
      head: null,
      isRepo: false,
      timer: null,
      draining: false,
      pending: false,
      failures: 0,
      sweepCursor: -1,
      stats: freshStats()
    }
    this.roots.set(key, state)
    state.unsubscribe = this.source.subscribeTick(root, (p) => this.onTick(state, p))
    if (reconcile) {
      state.needsReconcile = true
      this.armDrain(state)
    }
  }

  /** A rebuild landed: its walk is total truth as of its commit. New baseline, no dirt. */
  reseed(root: string, seed: { path: string; mtime: number; bytes: number }[]): void {
    const state = this.roots.get(foldProjectKey(root))
    if (!state) return
    state.applied = new Map(seed.map((r) => [r.path, { mtime: r.mtime, bytes: r.bytes }]))
    state.dirty.clear()
    state.deleted.clear()
    state.needsReconcile = false
    state.failures = 0
    state.sweepCursor = -1
  }

  /** A write the SERVICE itself landed and synchronously re-indexed (07): fold its
   *  fresh records into the applied baseline so the next tick's stat-compare sees the
   *  landing as absorbed, never as dirt. Bookkeeping only — no drain, no counters. */
  absorb(root: string, records: { path: string; mtime: number; bytes: number }[], removed: string[]): void {
    const state = this.roots.get(foldProjectKey(root))
    if (!state) return
    for (const p of removed) {
      state.applied.delete(p)
      state.dirty.delete(p)
      state.deleted.delete(p)
    }
    for (const r of records) {
      state.applied.set(r.path, { mtime: r.mtime, bytes: r.bytes })
      state.dirty.delete(r.path)
      state.deleted.delete(r.path)
    }
  }

  detach(root: string): void {
    const key = foldProjectKey(root)
    const state = this.roots.get(key)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.unsubscribe()
    this.roots.delete(key)
  }

  dispose(): void {
    for (const state of this.roots.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.unsubscribe()
    }
    this.roots.clear()
  }

  attached(root: string): boolean {
    return this.roots.has(foldProjectKey(root))
  }

  /** Staleness as DATA: how many paths the index knows it has not yet absorbed. */
  dirtyCount(root: string): number {
    const s = this.roots.get(foldProjectKey(root))
    return s ? s.dirty.size + s.deleted.size + (s.needsReconcile ? 1 : 0) : 0
  }

  draining(root: string): boolean {
    return this.roots.get(foldProjectKey(root))?.draining ?? false
  }

  statsFor(root: string): BrainFreshnessStats | null {
    const s = this.roots.get(foldProjectKey(root))
    if (!s) return null
    return {
      attached: true,
      isRepo: s.isRepo,
      dirty: s.dirty.size,
      deleted: s.deleted.size,
      needsReconcile: s.needsReconcile,
      draining: s.draining,
      ...s.stats
    }
  }

  // ── The ride: one tick, one root ────────────────────────────────────────────────

  private onTick(state: RootState, p: BrainTickPayload): void {
    state.stats.ticks++
    if (p.status && p.files && p.status.available) {
      state.isRepo = true
      this.onRepoBatch(state, p)
    } else if (!p.status) {
      state.isRepo = false
      this.sweep(state)
    }
    // p.status present but git degraded (available:false): trust nothing this beat.
    const head = p.status?.head ?? null
    if (head) {
      const prev = state.head
      state.head = head
      if (prev && prev !== head) void this.onHeadMove(state, prev, head)
    }
  }

  private onRepoBatch(state: RootState, p: BrainTickPayload): void {
    const current = new Set<string>()
    const memoryPaths: string[] = []
    const lockPaths: string[] = []
    for (const f of p.files ?? []) {
      const rel = f.path
      if (rel.startsWith('.mogging/')) continue // worktree plumbing is never source
      if (rel.startsWith('.memory/')) {
        memoryPaths.push(rel) // routed, never dirtied — the walk excludes it by law
        continue
      }
      if (isLockfile(rel)) lockPaths.push(rel)
      if (f.state === 'deleted') {
        if (state.applied.has(rel)) {
          state.deleted.add(rel)
          state.dirty.delete(rel)
        }
        continue
      }
      current.add(rel)
      if (rel.endsWith('/')) {
        // An untracked DIRECTORY: porcelain names the door, not the rooms. Only the walk
        // (gitignore-true) may enumerate them — anything less would drift from a rebuild.
        state.needsReconcile = true
        continue
      }
      this.consider(state, rel)
    }
    // Departures: a path porcelain listed last tick and dropped this tick was committed
    // (content unchanged — stat agrees, no dirt) or reverted/cleaned (content moved under
    // us — stat disagrees, dirt). One stat answers which.
    for (const rel of state.prevBatch) if (!current.has(rel)) this.consider(state, rel)
    state.prevBatch = current
    if (p.truncated) state.needsReconcile = true // an incomplete list is not a list
    if (memoryPaths.length) for (const cb of this.memorySubs) cb(state.root, memoryPaths)
    if (lockPaths.length) for (const cb of this.lockSubs) cb(state.root, lockPaths)
    this.armIfDirty(state)
  }

  /** The stat-compare heart: dirt is "the file on disk is not the file the index applied",
   *  nothing else. Porcelain says WHERE to look; this decides IF it matters — which is what
   *  keeps a standing-dirty repo (uncommitted work, every tick relisted) from churning. */
  private consider(state: RootState, rel: string): void {
    const rec = state.applied.get(rel)
    if (!rec && !indexableExt(rel)) return // no row, never routable: not ours
    let st
    try {
      st = statSync(path.join(state.root, rel))
    } catch {
      if (rec) {
        state.deleted.add(rel)
        state.dirty.delete(rel)
      }
      return
    }
    if (st.isDirectory()) {
      state.needsReconcile = true
      return
    }
    if (!rec || Math.floor(st.mtimeMs) !== rec.mtime || st.size !== rec.bytes) {
      state.dirty.add(rel)
      state.deleted.delete(rel) // a tombstoned path that reappeared is a change, not a wake
    }
  }

  /** Non-repo cadence beat: a capped, rotating, per-root-jittered mtime sweep of KNOWN
   *  files. No enumeration, no watcher — the rebuild remains folder mode's discovery. */
  private sweep(state: RootState): void {
    if (state.applied.size === 0) return
    state.stats.sweeps++
    const keys = [...state.applied.keys()].sort()
    if (state.sweepCursor < 0) state.sweepCursor = jitterOf(state.root, keys.length)
    const n = Math.min(BRAIN_SWEEP_SLICE, keys.length)
    for (let i = 0; i < n; i++) this.consider(state, keys[(state.sweepCursor + i) % keys.length])
    state.sweepCursor = (state.sweepCursor + n) % keys.length
    this.armIfDirty(state)
  }

  // ── Head moves ──────────────────────────────────────────────────────────────────

  private async onHeadMove(state: RootState, from: string, to: string): Promise<void> {
    state.stats.headMoves++
    const delta = await diffHeadMove(state.root, from, to)
    if (delta === null) {
      state.needsReconcile = true // git could not answer — the walk can
    } else {
      const memoryPaths: string[] = []
      for (const raw of delta) {
        const rel = raw.replace(/\\/g, '/')
        if (rel.startsWith('.mogging/')) continue
        if (rel.startsWith('.memory/')) {
          // A merge/checkout rewrites memories with a CLEAN tree — porcelain
          // will never re-announce them, so the head delta is their one signal.
          memoryPaths.push(rel)
          continue
        }
        // The same stat-compare: a commit-only move touched no worktree bytes, so its
        // paths fall out clean; a checkout rewrote exactly the delta, so they dirty.
        this.consider(state, rel)
      }
      if (memoryPaths.length) for (const cb of this.memorySubs) cb(state.root, memoryPaths)
    }
    this.armIfDirty(state)
  }

  // ── The drain ───────────────────────────────────────────────────────────────────

  private armIfDirty(state: RootState): void {
    if (state.dirty.size || state.deleted.size || state.needsReconcile) this.armDrain(state)
  }

  private armDrain(state: RootState, delayMs: number = BRAIN_DRAIN_QUIET_MS): void {
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.drain(state)
    }, delayMs)
    state.timer.unref?.()
  }

  private async drain(state: RootState): Promise<void> {
    if (state.draining) {
      state.pending = true
      return
    }
    if (!state.dirty.size && !state.deleted.size && !state.needsReconcile) return
    state.draining = true
    let sliceChanged: string[] = []
    let sliceDeleted: string[] = []
    let req: BrainDeltaRequest
    if (state.needsReconcile) {
      // The walk supersedes the sets: everything they hold is dirt the walk rediscovers.
      state.needsReconcile = false
      state.dirty.clear()
      state.deleted.clear()
      req = { changed: [], deleted: [], reconcile: true }
    } else {
      sliceDeleted = [...state.deleted].sort().slice(0, BRAIN_DRAIN_SLICE)
      sliceChanged = [...state.dirty].sort().slice(0, BRAIN_DRAIN_SLICE - sliceDeleted.length)
      for (const p of sliceDeleted) state.deleted.delete(p)
      for (const p of sliceChanged) state.dirty.delete(p)
      req = { changed: sliceChanged, deleted: sliceDeleted, reconcile: false }
    }
    try {
      const outcome = await this.deps.apply(state.root, req)
      if (!outcome) {
        // Refused or deferred: the dirt is still dirt. Put the slice back, retry on the
        // cadence — with a give-up wall so a permanently refusing project cannot loop.
        for (const p of sliceDeleted) state.deleted.add(p)
        for (const p of sliceChanged) state.dirty.add(p)
        if (req.reconcile) state.needsReconcile = true
        state.failures++
        if (state.failures <= MAX_CONSECUTIVE_FAILURES) this.armDrain(state, RETRY_MS * state.failures)
        return
      }
      state.failures = 0
      if (req.reconcile) state.stats.reconciles++
      if (outcome.applied) state.stats.drains++
      else state.stats.noopDrains++
      state.stats.lastProcessed = outcome.processed
      state.stats.lastRemoved = outcome.removed.length
      state.stats.lastCacheHits = outcome.cacheHits
      state.stats.lastCacheMisses = outcome.cacheMisses
      for (const p of outcome.removed) state.applied.delete(p)
      for (const r of outcome.records) state.applied.set(r.path, { mtime: r.mtime, bytes: r.bytes })
      // Echo dirt: a TICK that fired while this drain held its paths compared
      // against the PRE-drain baseline and re-marked exactly what the outcome
      // just absorbed — which would force a second, generation-bumping drain
      // over identical bytes. Re-run the one dirt predicate (disk ≠ applied)
      // against the FRESH baseline: tick echoes drop, real mid-drain writes
      // stay dirty, and an unstat-able path stays dirt for the next pass.
      for (const rel of [...state.dirty]) {
        const rec = state.applied.get(rel)
        if (!rec) continue
        try {
          const st = statSync(path.join(state.root, rel))
          if (Math.floor(st.mtimeMs) === rec.mtime && st.size === rec.bytes) state.dirty.delete(rel)
        } catch {
          /* cannot stat: the dirt stands */
        }
      }
      state.sweepCursor = -1
      if (outcome.applied) this.deps.applied?.(state.root, outcome)
    } finally {
      state.draining = false
    }
    // A spill (slice cap) or dirt marked mid-drain rolls into the next drain promptly —
    // dirty stayed counted the whole time.
    if (state.pending || state.dirty.size || state.deleted.size || state.needsReconcile) {
      state.pending = false
      this.armDrain(state, SPILL_MS)
    }
  }
}
