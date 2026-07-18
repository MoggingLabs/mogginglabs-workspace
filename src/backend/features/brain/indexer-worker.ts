import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { parse as parseJsonc } from 'jsonc-parser'
import { BRAIN_MAX_FILES } from '@contracts'
import { extractPortable, resolveProjectGraph, type ResolveContext } from './extract'
import { ParserPool, type GrammarCatalog, type ParseSkipReason, type TagCounts } from './parser-pool'
import { BrainStore } from './store'
import { walkRoot } from './walk'
import type { BrainFileRow, PortableExtraction } from './schema'
import catalogJson from './grammars.json'

// The brain's indexer WORKER (ADR 0018.f) — the only module graph that ever loads a
// parser. This step it is a SKELETON with the parse muscle only: paths in, tag
// counts out, one message at a time. No walking, no watching, no graph — 03 adds
// the walk + extraction on top of exactly this surface, and the spawn stays a plain
// `new Worker(out/main/brain-worker.js)` from the app service (nothing new listens).
//
// Message protocol (request/response by `id`, one reply per request):
//   { id, op: 'parse', path }  -> { id, ok, lang?, tagCounts?, hasError?, skipped? }
//   { id, op: 'status' }       -> { id, status: PoolStatus & { workerParses } }
//   { id, op: 'dispose' }      -> { id, done: true }   (frees every parser)

export interface BrainWorkerData {
  /** Where assets/grammars lives for THIS layout (dev appPath vs packaged asar). */
  grammarsDir: string
  parseTimeoutMs?: number
  maxFileBytes?: number
}

export interface BrainBuildOutcome {
  generation: number
  files: number
  nodes: number
  edges: number
  resolvedRefs: number
  droppedRefs: number
  cacheHits: number
  cacheMisses: number
  binarySkips: number
  parseSkips: number
}

/** One incremental drain's outcome (04). `applied:false` = nothing to do — the db was NOT
 *  touched, the generation did NOT move, and no `brain:changed` may be emitted for it. */
export interface BrainDeltaOutcome {
  generation: number
  applied: boolean
  /** Changed files actually re-resolved (read + hash + parse-or-cache) — the smoke's
   *  "delta-only" witness: a branch switch reparses the diff, never the tree. */
  processed: number
  /** Paths whose rows are gone (deleted, vanished, or no longer routable). */
  removed: string[]
  /** Fresh stat records for the freshness layer's applied map — including honest skips
   *  (binary, parse-refused), so a permanently skippable file stops re-dirtying. */
  records: { path: string; mtime: number; bytes: number }[]
  files: number
  nodes: number
  edges: number
  resolvedRefs: number
  droppedRefs: number
  cacheHits: number
  cacheMisses: number
}

export type BrainWorkerReply =
  | { id: number; ok: true; lang: string; tagCounts: TagCounts; hasError: boolean }
  | { id: number; ok: false; skipped: ParseSkipReason }
  | { id: number; status: ReturnType<ParserPool['status']> & { workerParses: number } }
  | { id: number; done: true }
  | { id: number; error: string }
  | { id: number; progress: { phase: 'walk' | 'parse' | 'commit'; done: number; total: number } }
  | { id: number; build: BrainBuildOutcome }
  | { id: number; delta: BrainDeltaOutcome }
  | { id: number; refusal: { reason: 'too-large'; fileCount: number; cap: number } }

const data = workerData as BrainWorkerData
const pool = new ParserPool({
  grammarsDir: data.grammarsDir,
  catalog: catalogJson as GrammarCatalog,
  parseTimeoutMs: data.parseTimeoutMs,
  maxFileBytes: data.maxFileBytes
})

const port = parentPort
if (!port) throw new Error('brain indexer must run as a worker_threads Worker')

/** tsconfig `paths` at the root (jsonc — comments are legal there), or nothing. */
function resolveContextFor(root: string): ResolveContext {
  try {
    const raw = parseJsonc(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    const paths = raw?.compilerOptions?.paths
    if (paths && typeof paths === 'object') {
      const tsPaths: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(paths)) {
        if (Array.isArray(v)) tsPaths[k] = v.filter((t): t is string => typeof t === 'string')
      }
      return { tsPaths }
    }
  } catch {
    /* no tsconfig, or unreadable — resolution proceeds without paths */
  }
  return { tsPaths: {} }
}

/** One file's whole road to a row: stat → read → sniff → hash → parse-or-cache. Shared
 *  VERBATIM by the full build and the incremental drain — the determinism arm of the
 *  freshness smoke (incremental dump == rebuild dump, byte-identical) rides on the two
 *  paths ingesting a file the exact same way. */
type IngestResult =
  | {
      kind: 'hit' | 'miss'
      row: BrainFileRow
      ex: PortableExtraction
      cacheRow: { lang: string; fileHash: string; ex: PortableExtraction } | null
    }
  | { kind: 'no-route' | 'unreadable' | 'binary' | 'parse-skip'; mtime: number; bytes: number }

async function ingestFile(store: BrainStore, root: string, rel: string): Promise<IngestResult> {
  const abs = path.join(root, rel)
  const lang = pool.routeExtension(rel)
  if (!lang) return { kind: 'no-route', mtime: 0, bytes: 0 } // unknown extension: not a row
  let bytes: Buffer
  let mtime: number
  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return { kind: 'unreadable', mtime: 0, bytes: 0 }
    bytes = readFileSync(abs)
    mtime = Math.floor(stat.mtimeMs)
  } catch {
    return { kind: 'unreadable', mtime: 0, bytes: 0 }
  }
  // Binary sniff: a NUL in the first 8 KiB means "not text" — counted, skipped.
  if (bytes.subarray(0, 8192).includes(0)) return { kind: 'binary', mtime, bytes: bytes.length }
  const hash = createHash('sha256').update(bytes).digest('hex')
  let ex = store.cacheGet(lang, hash)
  if (ex) {
    return {
      kind: 'hit',
      row: { root, path: rel, hash, lang, bytes: bytes.length, mtime, gen: 0 },
      ex,
      cacheRow: null
    }
  }
  const parsed = await pool.parseFile(abs, lang)
  if (!parsed.ok) return { kind: 'parse-skip', mtime, bytes: bytes.length }
  const query = pool.queryFor(lang)
  ex = query ? extractPortable(query, parsed.tree, lang) : { defs: [], imports: [], refs: [], heritage: [] }
  parsed.tree.delete()
  return {
    kind: 'miss',
    row: { root, path: rel, hash, lang, bytes: bytes.length, mtime, gen: 0 },
    ex,
    cacheRow: { lang, fileHash: hash, ex }
  }
}

/**
 * The FULL build of one root's partition: walk → hash → parse-or-cache → extract →
 * resolve → one transactional commit (chunked inserts, ONE generation bump). Every
 * skip is counted; the refusal carries counts; the db is untouched on refusal.
 */
async function build(
  id: number,
  dbPath: string,
  root: string,
  maxFiles: number
): Promise<BrainWorkerReply> {
  const walked = walkRoot(root, maxFiles)
  if (!walked.ok) {
    return { id, refusal: { reason: walked.reason, fileCount: walked.fileCount, cap: walked.cap } }
  }
  port!.postMessage({ id, progress: { phase: 'walk', done: walked.files.length, total: walked.files.length } } satisfies BrainWorkerReply)

  const store = new BrainStore(dbPath)
  try {
    const fileRows: BrainFileRow[] = []
    const extractions = new Map<string, PortableExtraction>()
    const cacheRows: { lang: string; fileHash: string; ex: PortableExtraction }[] = []
    let cacheHits = 0
    let cacheMisses = 0
    let binarySkips = 0
    let parseSkips = 0

    let done = 0
    for (const rel of walked.files) {
      done += 1
      if (done % 200 === 0) {
        port!.postMessage({ id, progress: { phase: 'parse', done, total: walked.files.length } } satisfies BrainWorkerReply)
      }
      const r = await ingestFile(store, root, rel)
      if (r.kind !== 'hit' && r.kind !== 'miss') {
        // 'no-route' is not source we can index — not a row, not a count (as ever).
        if (r.kind === 'unreadable' || r.kind === 'parse-skip') parseSkips += 1
        else if (r.kind === 'binary') binarySkips += 1
        continue
      }
      if (r.kind === 'hit') cacheHits += 1
      else {
        cacheMisses += 1
        if (r.cacheRow) cacheRows.push(r.cacheRow)
      }
      extractions.set(rel, r.ex)
      fileRows.push(r.row)
    }

    const graph = resolveProjectGraph(
      root,
      fileRows.map((f) => ({ path: f.path, lang: f.lang })),
      extractions,
      resolveContextFor(root)
    )
    port!.postMessage({ id, progress: { phase: 'commit', done: walked.files.length, total: walked.files.length } } satisfies BrainWorkerReply)
    const generation = store.replacePartition(
      root,
      fileRows,
      graph.nodes,
      graph.edges,
      cacheRows,
      { resolvedRefs: graph.resolvedRefs, droppedRefs: graph.droppedRefs, cacheHits, cacheMisses }
    )
    // files carry the generation that indexed them — set at commit, ONE bump.
    return {
      id,
      build: {
        generation,
        files: fileRows.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        resolvedRefs: graph.resolvedRefs,
        droppedRefs: graph.droppedRefs,
        cacheHits,
        cacheMisses,
        binarySkips,
        parseSkips
      }
    }
  } finally {
    store.dispose()
  }
}

/**
 * The INCREMENTAL apply (04): re-resolve exactly the changed paths, drop exactly the dead
 * ones, keep every other row and pull its extraction back from the content-addressed cache
 * (no bytes re-read) — then re-run the SAME whole-partition resolution a build runs and
 * commit through the SAME one-transaction replacePartition. ONE generation bump. Reference
 * edges cross files, so resolution is never patched in place — recomputing it from cached
 * extractions is what makes the incremental dump provably byte-identical to a rebuild's.
 *
 * `reconcile` is the cold-start/fallback mode: ignore the lists, walk the root, and let the
 * (mtime, bytes) prefilter against the stored rows decide what changed — hashing (and the
 * parse-or-cache behind it) is only ever paid where the prefilter disagrees.
 */
async function applyDelta(
  id: number,
  dbPath: string,
  root: string,
  changed: string[],
  deleted: string[],
  reconcile: boolean,
  maxFiles: number
): Promise<BrainWorkerReply> {
  const store = new BrainStore(dbPath)
  try {
    const existing = store.filesForRoot(root)
    const byPath = new Map(existing.map((r) => [r.path, r]))
    const changedSet = new Set(changed)
    const deletedSet = new Set(deleted)
    if (reconcile) {
      changedSet.clear()
      deletedSet.clear()
      const walked = walkRoot(root, maxFiles)
      if (!walked.ok) {
        return { id, refusal: { reason: walked.reason, fileCount: walked.fileCount, cap: walked.cap } }
      }
      const walkSet = new Set(walked.files)
      for (const rel of walked.files) {
        const row = byPath.get(rel)
        if (!row) {
          if (pool.routeExtension(rel)) changedSet.add(rel) // appeared while we were not looking
          continue
        }
        try {
          const st = statSync(path.join(root, rel))
          // The mtime prefilter: a row whose (mtime, bytes) still match is taken at its
          // word — hash-compare (via re-ingest) is only paid where the stat disagrees.
          if (Math.floor(st.mtimeMs) !== row.mtime || st.size !== row.bytes) changedSet.add(rel)
        } catch {
          deletedSet.add(rel)
        }
      }
      for (const row of existing) if (!walkSet.has(row.path)) deletedSet.add(row.path)
    }

    let removed: string[] = []
    for (const rel of deletedSet) if (byPath.has(rel)) removed.push(rel)
    // Nothing to re-resolve, nothing to drop: an honest no-op. The db is untouched, the
    // generation does not move, and the caller emits nothing for it.
    if (changedSet.size === 0 && removed.length === 0) {
      const stats = store.buildStats()
      const counts = store.partitionCounts(root)
      return {
        id,
        delta: {
          generation: store.generation(),
          applied: false,
          processed: 0,
          removed: [],
          records: [],
          ...counts,
          resolvedRefs: stats.resolvedRefs,
          droppedRefs: stats.droppedRefs,
          cacheHits: 0,
          cacheMisses: 0
        }
      }
    }

    const fileRows: BrainFileRow[] = []
    const extractions = new Map<string, PortableExtraction>()
    const cacheRows: { lang: string; fileHash: string; ex: PortableExtraction }[] = []
    const records: { path: string; mtime: number; bytes: number }[] = []
    let cacheHits = 0
    let cacheMisses = 0
    let processed = 0

    // Unchanged files keep their rows verbatim; extractions come back from the
    // content-addressed cache. A lost cache row degrades to an honest re-ingest.
    for (const row of existing) {
      if (deletedSet.has(row.path) || changedSet.has(row.path)) continue
      const ex = store.cacheGet(row.lang, row.hash)
      if (!ex) {
        changedSet.add(row.path)
        continue
      }
      extractions.set(row.path, ex)
      fileRows.push({ root, path: row.path, hash: row.hash, lang: row.lang, bytes: row.bytes, mtime: row.mtime, gen: 0 })
    }

    for (const rel of [...changedSet].sort()) {
      processed += 1
      const r = await ingestFile(store, root, rel)
      if (r.kind === 'hit' || r.kind === 'miss') {
        if (r.kind === 'hit') cacheHits += 1
        else {
          cacheMisses += 1
          if (r.cacheRow) cacheRows.push(r.cacheRow)
        }
        extractions.set(rel, r.ex)
        fileRows.push(r.row)
        records.push({ path: rel, mtime: r.row.mtime, bytes: r.row.bytes })
        continue
      }
      // The path did not become a row. If it used to be one, its rows go. A STABLE skip
      // (binary, parse-refused) is recorded so it stops re-dirtying; an unreadable file
      // records nothing — transient failures must come back and retry.
      if (byPath.has(rel)) removed.push(rel)
      if (r.kind === 'binary' || r.kind === 'parse-skip') records.push({ path: rel, mtime: r.mtime, bytes: r.bytes })
    }

    // A tombstoned path that was recreated mid-window resolves as a ROW, not a removal.
    const rowPaths = new Set(fileRows.map((f) => f.path))
    removed = removed.filter((p) => !rowPaths.has(p))

    // Sorted exactly as the walk sorts: the resolver must see the same file order a full
    // build gives it — half of what makes the two dumps byte-identical.
    fileRows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

    const graph = resolveProjectGraph(
      root,
      fileRows.map((f) => ({ path: f.path, lang: f.lang })),
      extractions,
      resolveContextFor(root)
    )
    const generation = store.replacePartition(root, fileRows, graph.nodes, graph.edges, cacheRows, {
      resolvedRefs: graph.resolvedRefs,
      droppedRefs: graph.droppedRefs,
      cacheHits,
      cacheMisses
    })
    return {
      id,
      delta: {
        generation,
        applied: true,
        processed,
        removed,
        records,
        files: fileRows.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        resolvedRefs: graph.resolvedRefs,
        droppedRefs: graph.droppedRefs,
        cacheHits,
        cacheMisses
      }
    }
  } finally {
    store.dispose()
  }
}

port.on('message', (msg: { id: number; op: string; path?: string; dbPath?: string; root?: string; maxFiles?: number; changed?: string[]; deleted?: string[] }) => {
  void (async (): Promise<void> => {
    try {
      if (msg.op === 'parse' && typeof msg.path === 'string') {
        const lang = pool.routeExtension(msg.path)
        if (!lang) {
          // An unknown extension is an honest, COUNTED skip — never an error.
          port.postMessage({ id: msg.id, ok: false, skipped: pool.noteSkip('unknown-extension') } satisfies BrainWorkerReply)
          return
        }
        const result = await pool.parseFile(msg.path, lang)
        if (result.ok) {
          const reply: BrainWorkerReply = {
            id: msg.id,
            ok: true,
            lang: result.lang,
            tagCounts: result.tagCounts,
            hasError: result.hasError
          }
          result.tree.delete() // 03 consumes trees; the skeleton only ever needed the counts
          port.postMessage(reply)
        } else {
          port.postMessage({ id: msg.id, ok: false, skipped: result.skipped } satisfies BrainWorkerReply)
        }
      } else if (msg.op === 'build' && typeof msg.dbPath === 'string' && typeof msg.root === 'string') {
        port.postMessage(
          await build(
            msg.id,
            msg.dbPath,
            msg.root,
            typeof msg.maxFiles === 'number' ? msg.maxFiles : BRAIN_MAX_FILES
          )
        )
      } else if (
        (msg.op === 'applyDelta' || msg.op === 'reconcile') &&
        typeof msg.dbPath === 'string' &&
        typeof msg.root === 'string'
      ) {
        port.postMessage(
          await applyDelta(
            msg.id,
            msg.dbPath,
            msg.root,
            Array.isArray(msg.changed) ? msg.changed.filter((p): p is string => typeof p === 'string') : [],
            Array.isArray(msg.deleted) ? msg.deleted.filter((p): p is string => typeof p === 'string') : [],
            msg.op === 'reconcile',
            typeof msg.maxFiles === 'number' ? msg.maxFiles : BRAIN_MAX_FILES
          )
        )
      } else if (msg.op === 'status') {
        port.postMessage({
          id: msg.id,
          status: { ...pool.status(), workerParses: globalThis.__moggingBrainParses ?? 0 }
        } satisfies BrainWorkerReply)
      } else if (msg.op === 'dispose') {
        pool.dispose()
        port.postMessage({ id: msg.id, done: true } satisfies BrainWorkerReply)
      } else {
        port.postMessage({ id: msg.id, error: 'unknown op' } satisfies BrainWorkerReply)
      }
    } catch (e) {
      port.postMessage({ id: msg.id, error: String(e) } satisfies BrainWorkerReply)
    }
  })()
})
