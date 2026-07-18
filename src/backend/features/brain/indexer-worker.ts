import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
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

export type BrainWorkerReply =
  | { id: number; ok: true; lang: string; tagCounts: TagCounts; hasError: boolean }
  | { id: number; ok: false; skipped: ParseSkipReason }
  | { id: number; status: ReturnType<ParserPool['status']> & { workerParses: number } }
  | { id: number; done: true }
  | { id: number; error: string }
  | { id: number; progress: { phase: 'walk' | 'parse' | 'commit'; done: number; total: number } }
  | { id: number; build: BrainBuildOutcome }
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
      const abs = path.join(root, rel)
      const lang = pool.routeExtension(rel)
      if (!lang) continue // unknown extension: not source we can index — not a row
      let bytes: Buffer
      let mtime: number
      try {
        const stat = statSync(abs)
        bytes = readFileSync(abs)
        mtime = Math.floor(stat.mtimeMs)
      } catch {
        parseSkips += 1
        continue
      }
      // Binary sniff: a NUL in the first 8 KiB means "not text" — counted, skipped.
      if (bytes.subarray(0, 8192).includes(0)) {
        binarySkips += 1
        continue
      }
      const hash = createHash('sha256').update(bytes).digest('hex')
      let ex = store.cacheGet(lang, hash)
      if (ex) {
        cacheHits += 1
      } else {
        const parsed = await pool.parseFile(abs, lang)
        if (!parsed.ok) {
          parseSkips += 1
          continue
        }
        const query = pool.queryFor(lang)
        ex = query
          ? extractPortable(query, parsed.tree, lang)
          : { defs: [], imports: [], refs: [], heritage: [] }
        parsed.tree.delete()
        cacheMisses += 1
        cacheRows.push({ lang, fileHash: hash, ex })
      }
      extractions.set(rel, ex)
      fileRows.push({ root, path: rel, hash, lang, bytes: bytes.length, mtime, gen: 0 })
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

port.on('message', (msg: { id: number; op: string; path?: string; dbPath?: string; root?: string; maxFiles?: number }) => {
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
