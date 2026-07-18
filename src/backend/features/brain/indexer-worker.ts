import { parentPort, workerData } from 'node:worker_threads'
import { ParserPool, type GrammarCatalog, type ParseSkipReason, type TagCounts } from './parser-pool'
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

export type BrainWorkerReply =
  | { id: number; ok: true; lang: string; tagCounts: TagCounts; hasError: boolean }
  | { id: number; ok: false; skipped: ParseSkipReason }
  | { id: number; status: ReturnType<ParserPool['status']> & { workerParses: number } }
  | { id: number; done: true }
  | { id: number; error: string }

const data = workerData as BrainWorkerData
const pool = new ParserPool({
  grammarsDir: data.grammarsDir,
  catalog: catalogJson as GrammarCatalog,
  parseTimeoutMs: data.parseTimeoutMs,
  maxFileBytes: data.maxFileBytes
})

const port = parentPort
if (!port) throw new Error('brain indexer must run as a worker_threads Worker')

port.on('message', (msg: { id: number; op: string; path?: string }) => {
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
