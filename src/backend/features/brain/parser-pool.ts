import { readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Language, Parser, Query, type Tree } from 'web-tree-sitter'
import { BRAIN_MAX_FILE_BYTES } from '@contracts'

// The brain's parser pool (ADR 0018.g): web-tree-sitter — WASM ONLY, a native
// tree-sitter binding is a review rejection — over the vendored, hash-pinned
// grammar catalog (grammars.json + assets/grammars/, held by the GRAMMARCAT gate).
//
// LOADED BY THE worker_threads INDEXER ALONE (indexer-worker.ts). Neither main nor
// the renderer ever imports this module: parsing is off-thread by construction, and
// the BRAINPARSE gate proves it via the instrumentation counter below (main-thread
// count must be zero). Failure posture is the brain's everywhere-posture: a file
// that cannot be parsed — unknown extension, over the byte cap, grammar refuses,
// timeout — is a COUNTED SKIP, never a crash and never an error dialog.

/** Live Parser instances kept at once. Languages/queries cache unbounded (the whole
 *  roster is 18); parsers hold larger wasm state, so the LRU closes the coldest. */
export const BRAIN_LIVE_PARSER_CAP = 8
/** Per-parse wall-clock budget. A grammar wedged on pathological input is cancelled
 *  via the parse progress callback — the file becomes a counted skip. */
export const BRAIN_PARSE_TIMEOUT_MS = 2_000

export interface GrammarRow {
  lang: string
  wasm: string
  sha256: string
  version: string
  sourceRepo: string
  releaseTag: string
  extensions: string[]
  licence: string
}

export interface GrammarCatalog {
  grammars: GrammarRow[]
}

export interface TagCounts {
  defs: number
  refs: number
  imports: number
}

export type ParseSkipReason = 'unknown-extension' | 'too-large' | 'parse-failed'

export type ParseFileResult =
  | { ok: true; lang: string; tree: Tree; tagCounts: TagCounts; hasError: boolean }
  | { ok: false; skipped: ParseSkipReason }

export interface PoolStatus {
  /** Languages actually LOADED — lazy by law, so an untouched language never appears. */
  loaded: string[]
  liveParsers: number
  parses: number
  skips: Record<ParseSkipReason, number>
}

export interface ParserPoolOptions {
  /** Where the vendored artifacts live (assets/grammars). */
  grammarsDir: string
  catalog: GrammarCatalog
  parseTimeoutMs?: number
  maxFileBytes?: number
  liveParserCap?: number
}

// The BRAINPARSE gate's witness that parsing never happens on the wrong thread:
// every successful parse bumps this thread-local global. The smoke reads it in MAIN
// (must be undefined/0) and asks the worker for its own count (must equal the work).
declare global {
  var __moggingBrainParses: number | undefined
}

export class ParserPool {
  private readonly grammarsDir: string
  private readonly catalog: GrammarCatalog
  private readonly parseTimeoutMs: number
  private readonly maxFileBytes: number
  private readonly liveParserCap: number
  private readonly byExtension = new Map<string, string>()
  private readonly languages = new Map<string, { language: Language; query: Query | null }>()
  /** Insertion-ordered: the Map IS the LRU (delete + re-set marks recency). */
  private readonly parsers = new Map<string, Parser>()
  private initDone: Promise<void> | null = null
  private parses = 0
  private readonly skips: Record<ParseSkipReason, number> = {
    'unknown-extension': 0,
    'too-large': 0,
    'parse-failed': 0
  }

  constructor(opts: ParserPoolOptions) {
    this.grammarsDir = opts.grammarsDir
    this.catalog = opts.catalog
    this.parseTimeoutMs = opts.parseTimeoutMs ?? BRAIN_PARSE_TIMEOUT_MS
    this.maxFileBytes = opts.maxFileBytes ?? BRAIN_MAX_FILE_BYTES
    this.liveParserCap = opts.liveParserCap ?? BRAIN_LIVE_PARSER_CAP
    for (const row of this.catalog.grammars) {
      for (const ext of row.extensions) this.byExtension.set(ext.toLowerCase(), row.lang)
    }
  }

  /** Extension → language, from the catalog alone. Null is an HONEST unknown —
   *  the caller counts it as a skip; it is never an error. */
  routeExtension(path: string): string | null {
    return this.byExtension.get(extname(path).toLowerCase()) ?? null
  }

  /** Route + parse + tag-count one file. Every failure mode is a counted skip. */
  async parseFile(path: string, lang: string): Promise<ParseFileResult> {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return this.skip('parse-failed')
    }
    // The cap binds BEFORE the read: an oversized file costs a stat, never its bytes.
    if (size > this.maxFileBytes) return this.skip('too-large')

    let loaded: { language: Language; query: Query | null }
    let parser: Parser
    let source: string
    try {
      await this.ensureInit()
      loaded = await this.ensureLanguage(lang)
      parser = this.ensureParser(lang, loaded.language)
      source = readFileSync(path, 'utf8')
    } catch {
      return this.skip('parse-failed')
    }

    const deadline = Date.now() + this.parseTimeoutMs
    let tree: Tree | null = null
    try {
      tree = parser.parse(source, null, { progressCallback: () => Date.now() > deadline })
    } catch {
      tree = null
    }
    if (!tree) {
      // A cancelled or refused parse can leave the parser mid-state; drop it — the
      // pool is lazy, the next file rebuilds one.
      this.dropParser(lang)
      return this.skip('parse-failed')
    }

    const tagCounts: TagCounts = { defs: 0, refs: 0, imports: 0 }
    if (loaded.query) {
      for (const capture of loaded.query.captures(tree.rootNode)) {
        if (capture.name.startsWith('definition')) tagCounts.defs += 1
        else if (capture.name.startsWith('reference')) tagCounts.refs += 1
        else if (capture.name.startsWith('import')) tagCounts.imports += 1
      }
    }
    this.parses += 1
    globalThis.__moggingBrainParses = (globalThis.__moggingBrainParses ?? 0) + 1
    return { ok: true, lang, tree, tagCounts, hasError: tree.rootNode.hasError }
  }

  /** The compiled tag query for a LOADED language — the extraction's other input.
   *  Null until parseFile loaded the language (lazy by law) or when no query ships. */
  queryFor(lang: string): Query | null {
    return this.languages.get(lang)?.query ?? null
  }

  status(): PoolStatus {
    return {
      loaded: [...this.languages.keys()],
      liveParsers: this.parsers.size,
      parses: this.parses,
      skips: { ...this.skips }
    }
  }

  dispose(): void {
    for (const parser of this.parsers.values()) {
      try {
        parser.delete()
      } catch {
        /* already deleted */
      }
    }
    this.parsers.clear()
    this.languages.clear()
  }

  /** Count a skip decided OUTSIDE parseFile (the worker's unknown-extension route)
   *  in the same ledger, so status() reports every skip from one place. */
  noteSkip(reason: ParseSkipReason): ParseSkipReason {
    this.skips[reason] += 1
    return reason
  }

  private skip(reason: ParseSkipReason): ParseFileResult {
    this.skips[reason] += 1
    return { ok: false, skipped: reason }
  }

  private ensureInit(): Promise<void> {
    // Bare init: the emscripten loader finds web-tree-sitter.wasm beside the module
    // it loaded from (node_modules — dev and asar alike; Electron patches fs).
    if (!this.initDone) this.initDone = Parser.init()
    return this.initDone
  }

  private async ensureLanguage(lang: string): Promise<{ language: Language; query: Query | null }> {
    const cached = this.languages.get(lang)
    if (cached) return cached
    const row = this.catalog.grammars.find((r) => r.lang === lang)
    if (!row) throw new Error(`no catalog row for '${lang}'`)
    // BYTES, not a path: asar-transparent, and exactly the bytes the catalog pinned.
    const language = await Language.load(
      new Uint8Array(readFileSync(join(this.grammarsDir, row.wasm)))
    )
    let query: Query | null = null
    try {
      query = new Query(language, readFileSync(join(this.grammarsDir, 'queries', `${lang}.scm`), 'utf8'))
    } catch {
      // A missing/uncompilable query degrades to zero tag counts — the parse itself
      // still answers. GRAMMARCAT is what keeps queries present and current.
      query = null
    }
    const loaded = { language, query }
    this.languages.set(lang, loaded)
    return loaded
  }

  private ensureParser(lang: string, language: Language): Parser {
    const existing = this.parsers.get(lang)
    if (existing) {
      this.parsers.delete(lang)
      this.parsers.set(lang, existing)
      return existing
    }
    while (this.parsers.size >= this.liveParserCap) {
      const coldest = this.parsers.entries().next().value
      if (!coldest) break
      try {
        coldest[1].delete()
      } catch {
        /* already deleted */
      }
      this.parsers.delete(coldest[0])
    }
    const parser = new Parser()
    parser.setLanguage(language)
    this.parsers.set(lang, parser)
    return parser
  }

  private dropParser(lang: string): void {
    const parser = this.parsers.get(lang)
    if (!parser) return
    try {
      parser.delete()
    } catch {
      /* already deleted */
    }
    this.parsers.delete(lang)
  }
}
