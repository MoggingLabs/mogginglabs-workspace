import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { requireNative } from '../../platform/native-require'
import { foldProjectKey } from '../workspace/project-identity'
import {
  BRAIN_GRAPH_DDL,
  type BrainEdgeRow,
  type BrainFileRow,
  type BrainNodeRow,
  type BrainRankRow,
  type PortableExtraction
} from './schema'

// The per-project brain db (ADR 0018.b): DERIVED state under the app data dir —
// deletable, rebuildable, never in the repo. Same mechanism as every other store
// (better-sqlite3 through the host-aware seam, WAL). v1 was `meta` alone (step 02:
// the lifecycle laws first); v2 is the graph — files/nodes/edges partitioned by
// root, plus the GLOBAL content-addressed parse_cache. The migration is versioned
// and one-way; a v1 db upgrades in place, losing nothing (it had nothing to lose).

const Database = requireNative<typeof import('better-sqlite3')>('better-sqlite3')

export const BRAIN_SCHEMA_VERSION = 3 // v3: the ranks table (06) — additive, one-way, idempotent
/** Multi-row insert batch size — the build's transactional chunking unit. */
export const BRAIN_INSERT_CHUNK = 1000

export interface BrainCounts {
  files: number
  nodes: number
  edges: number
  languages: string[]
}

/** The LAST build's fidelity + cache economics (ADR 0018.d: reported, never faked). */
export interface BrainBuildStats {
  resolvedRefs: number
  droppedRefs: number
  cacheHits: number
  cacheMisses: number
}

/** `brain/<projectKey>.db` with the key made filename-safe: a project key is an
 *  absolute path, so the file takes its sha256 — over the FOLDED key, because the
 *  board's comparison rule (two Windows spellings of one folder are one project)
 *  must mean one db, not two. Deterministic: the same project always answers from
 *  the same file, and deleting it deletes exactly that project's brain. */
export function brainDbPath(baseDir: string, projectKey: string): string {
  const hash = createHash('sha256').update(foldProjectKey(projectKey)).digest('hex').slice(0, 32)
  return path.join(baseDir, `${hash}.db`)
}

export class BrainStore {
  private readonly db: BetterSqlite3.Database

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER NOT NULL, generation INTEGER NOT NULL)'
    )
    const seeded = this.db.prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number }
    if (!seeded.n) {
      this.db
        .prepare('INSERT INTO meta (schema_version, generation) VALUES (?, 1)')
        .run(BRAIN_SCHEMA_VERSION)
    }
    this.migrate()
  }

  /** v1 → v2: the graph tables + the build-stats columns on meta. Idempotent —
   *  every open runs it; a current db is a no-op. */
  private migrate(): void {
    this.db.exec(BRAIN_GRAPH_DDL)
    const cols = (this.db.prepare('PRAGMA table_info(meta)').all() as { name: string }[]).map(
      (c) => c.name
    )
    for (const col of ['resolved_refs', 'dropped_refs', 'cache_hits', 'cache_misses']) {
      if (!cols.includes(col)) {
        this.db.exec(`ALTER TABLE meta ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`)
      }
    }
    this.db.prepare('UPDATE meta SET schema_version = ?').run(BRAIN_SCHEMA_VERSION)
  }

  generation(): number {
    const row = this.db.prepare('SELECT generation FROM meta').get() as
      | { generation: number }
      | undefined
    return row?.generation ?? 1
  }

  counts(): BrainCounts {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n
    return {
      files: one('SELECT COUNT(*) AS n FROM files'),
      nodes: one('SELECT COUNT(*) AS n FROM nodes'),
      edges: one('SELECT COUNT(*) AS n FROM edges'),
      languages: (
        this.db.prepare('SELECT DISTINCT lang FROM files ORDER BY lang').all() as { lang: string }[]
      ).map((r) => r.lang)
    }
  }

  buildStats(): BrainBuildStats {
    const row = this.db
      .prepare(
        'SELECT resolved_refs AS resolvedRefs, dropped_refs AS droppedRefs, cache_hits AS cacheHits, cache_misses AS cacheMisses FROM meta'
      )
      .get() as BrainBuildStats | undefined
    return row ?? { resolvedRefs: 0, droppedRefs: 0, cacheHits: 0, cacheMisses: 0 }
  }

  /** One partition's row counts — the no-op drain's honest answer (04). */
  partitionCounts(root: string): { files: number; nodes: number; edges: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get(root) as { n: number }).n
    return {
      files: one('SELECT COUNT(*) AS n FROM files WHERE root = ?'),
      nodes: one('SELECT COUNT(*) AS n FROM nodes WHERE root = ?'),
      edges: one('SELECT COUNT(*) AS n FROM edges WHERE root = ?')
    }
  }

  /** One partition's file rows, path-ordered — the incremental path's baseline (04): the
   *  drain keeps these for unchanged files and the freshness layer stat-compares against
   *  their (mtime, bytes) to decide what "changed" even means. */
  filesForRoot(root: string): { path: string; hash: string; lang: string; bytes: number; mtime: number }[] {
    return this.db
      .prepare('SELECT path, hash, lang, bytes, mtime FROM files WHERE root = ? ORDER BY path')
      .all(root) as { path: string; hash: string; lang: string; bytes: number; mtime: number }[]
  }

  cacheGet(lang: string, fileHash: string): PortableExtraction | null {
    const row = this.db
      .prepare('SELECT nodesJson, edgesJson FROM parse_cache WHERE lang = ? AND fileHash = ?')
      .get(lang, fileHash) as { nodesJson: string; edgesJson: string } | undefined
    if (!row) return null
    try {
      const rest = JSON.parse(row.edgesJson) as Omit<PortableExtraction, 'defs'>
      return { defs: JSON.parse(row.nodesJson), ...rest }
    } catch {
      return null // a corrupt cache row degrades to a re-parse, never a crash
    }
  }

  /**
   * The build's ONE commit: replace the root's whole partition, add the new cache
   * rows, persist the build stats, bump the generation — a single transaction with
   * chunked multi-row inserts (BRAIN_INSERT_CHUNK). Returns the new generation.
   */
  replacePartition(
    root: string,
    files: BrainFileRow[],
    nodes: BrainNodeRow[],
    edges: BrainEdgeRow[],
    cacheRows: { lang: string; fileHash: string; ex: PortableExtraction }[],
    stats: BrainBuildStats,
    ranks: BrainRankRow[] = []
  ): number {
    const insertChunked = <T>(rows: T[], cols: number, sql: (placeholders: string) => string, flat: (r: T) => unknown[]): void => {
      for (let i = 0; i < rows.length; i += BRAIN_INSERT_CHUNK) {
        const chunk = rows.slice(i, i + BRAIN_INSERT_CHUNK)
        const placeholders = chunk.map(() => `(${Array(cols).fill('?').join(',')})`).join(',')
        this.db.prepare(sql(placeholders)).run(...chunk.flatMap(flat))
      }
    }
    const txn = this.db.transaction((): number => {
      // ONE bump per build, stamped onto the rows it indexed — read first so the
      // files rows and the meta row can never disagree about which build this was.
      const gen = this.generation() + 1
      for (const table of ['files', 'nodes', 'edges', 'ranks']) {
        this.db.prepare(`DELETE FROM ${table} WHERE root = ?`).run(root)
      }
      insertChunked(files, 7, (p) => `INSERT OR REPLACE INTO files (root,path,hash,lang,bytes,mtime,gen) VALUES ${p}`, (f) => [f.root, f.path, f.hash, f.lang, f.bytes, f.mtime, gen])
      insertChunked(nodes, 8, (p) => `INSERT OR REPLACE INTO nodes (id,root,kind,name,file,startLine,endLine,sig) VALUES ${p}`, (n) => [n.id, n.root, n.kind, n.name, n.file, n.startLine, n.endLine, n.sig])
      insertChunked(edges, 4, (p) => `INSERT OR IGNORE INTO edges (src,dst,kind,root) VALUES ${p}`, (e) => [e.src, e.dst, e.kind, e.root])
      insertChunked(cacheRows, 4, (p) => `INSERT OR IGNORE INTO parse_cache (lang,fileHash,nodesJson,edgesJson) VALUES ${p}`, (c) => [c.lang, c.fileHash, JSON.stringify(c.ex.defs), JSON.stringify({ imports: c.ex.imports, refs: c.ex.refs, heritage: c.ex.heritage })])
      // The repomap ranks (06) ride the SAME commit as the rows they describe.
      insertChunked(ranks, 3, (p) => `INSERT OR REPLACE INTO ranks (id,root,rank) VALUES ${p}`, (r) => [r.id, root, r.rank])
      this.db
        .prepare(
          'UPDATE meta SET generation = ?, resolved_refs = ?, dropped_refs = ?, cache_hits = ?, cache_misses = ?'
        )
        .run(gen, stats.resolvedRefs, stats.droppedRefs, stats.cacheHits, stats.cacheMisses)
      return gen
    })
    return txn()
  }

  // ── Graph reads (ADR 0018, step 05): the serve layer's SQL, and nothing else's.
  // Every list is ordered the same stable way — (root, file, startLine, id) — so
  // pagination pages never shuffle between asks of the same generation.

  private static rootsClause(roots: string[]): { sql: string; params: string[] } {
    return { sql: `root IN (${roots.map(() => '?').join(',')})`, params: roots }
  }

  /** One page of nodes filtered by kind / name-LIKE / file-LIKE (patterns are
   *  pre-translated globs; ESCAPE '\'). Fetch limit+1 to learn `more` honestly. */
  nodesPage(
    roots: string[],
    filter: { kind?: string; nameLike?: string; fileLike?: string },
    limit: number,
    offset: number
  ): { rows: BrainNodeRow[]; more: boolean } {
    if (!roots.length) return { rows: [], more: false }
    const rc = BrainStore.rootsClause(roots)
    const where = [rc.sql]
    const params: (string | number)[] = [...rc.params]
    if (filter.kind) {
      where.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.nameLike !== undefined) {
      where.push("name LIKE ? ESCAPE '\\'")
      params.push(filter.nameLike)
    }
    if (filter.fileLike !== undefined) {
      where.push("file LIKE ? ESCAPE '\\'")
      params.push(filter.fileLike)
    }
    const rows = this.db
      .prepare(
        `SELECT id, root, kind, name, file, startLine, endLine, sig FROM nodes WHERE ${where.join(' AND ')} ORDER BY root, file, startLine, id LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as BrainNodeRow[]
    return { rows: rows.slice(0, limit), more: rows.length > limit }
  }

  nodeById(id: string): BrainNodeRow | null {
    return (
      (this.db
        .prepare('SELECT id, root, kind, name, file, startLine, endLine, sig FROM nodes WHERE id = ?')
        .get(id) as BrainNodeRow | undefined) ?? null
    )
  }

  nodesByIds(ids: string[]): BrainNodeRow[] {
    if (!ids.length) return []
    return this.db
      .prepare(
        `SELECT id, root, kind, name, file, startLine, endLine, sig FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as BrainNodeRow[]
  }

  /** Definition nodes by EXACT name within the given partitions. */
  nodesByExactName(roots: string[], name: string, kind?: string): BrainNodeRow[] {
    if (!roots.length) return []
    const rc = BrainStore.rootsClause(roots)
    const params: string[] = [...rc.params, name]
    let sql = `SELECT id, root, kind, name, file, startLine, endLine, sig FROM nodes WHERE ${rc.sql} AND name = ?`
    if (kind) {
      sql += ' AND kind = ?'
      params.push(kind)
    }
    return this.db.prepare(sql + ' ORDER BY root, file, startLine, id').all(...params) as BrainNodeRow[]
  }

  /** Edges touching one node. `dir` per edge answers which side the node sits on. */
  edgesTouching(
    id: string,
    direction: 'in' | 'out' | 'both',
    kinds: string[] | null,
    limit: number
  ): { edge: BrainEdgeRow; dir: 'in' | 'out' }[] {
    const kindClause = kinds && kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
    const kindParams = kinds ?? []
    const out: { edge: BrainEdgeRow; dir: 'in' | 'out' }[] = []
    if (direction === 'out' || direction === 'both') {
      const rows = this.db
        .prepare(`SELECT src, dst, kind, root FROM edges WHERE src = ?${kindClause} ORDER BY kind, dst LIMIT ?`)
        .all(id, ...kindParams, limit) as BrainEdgeRow[]
      for (const edge of rows) out.push({ edge, dir: 'out' })
    }
    if (direction === 'in' || direction === 'both') {
      const rows = this.db
        .prepare(`SELECT src, dst, kind, root FROM edges WHERE dst = ?${kindClause} ORDER BY kind, src LIMIT ?`)
        .all(id, ...kindParams, limit) as BrainEdgeRow[]
      for (const edge of rows) out.push({ edge, dir: 'in' })
    }
    return out.slice(0, limit)
  }

  /** One partition's renderable map rows (06): every signature-bearing node with
   *  its committed rank — stably ordered so the renderer's input never shuffles. */
  repoMapRows(root: string): { file: string; startLine: number; sig: string; rank: number }[] {
    return this.db
      .prepare(
        `SELECT n.file AS file, n.startLine AS startLine, n.sig AS sig, COALESCE(r.rank, 0) AS rank
         FROM nodes n LEFT JOIN ranks r ON r.id = n.id
         WHERE n.root = ? AND n.sig != '' ORDER BY n.file, n.startLine, n.id`
      )
      .all(root) as { file: string; startLine: number; sig: string; rank: number }[]
  }

  /** RESOLVED incoming reference edges to any of `ids`, stably ordered. */
  referencesInto(ids: string[], limit: number): BrainEdgeRow[] {
    if (!ids.length) return []
    return this.db
      .prepare(
        `SELECT src, dst, kind, root FROM edges WHERE kind = 'references' AND dst IN (${ids.map(() => '?').join(',')}) ORDER BY dst, src LIMIT ?`
      )
      .all(...ids, limit) as BrainEdgeRow[]
  }

  /**
   * The determinism proof's material: every non-volatile row, totally ordered, one
   * JSON line each. mtime and gen are EXCLUDED by design (they are when-facts, not
   * what-facts); everything else must reproduce byte-for-byte from the same bytes.
   */
  dumpCanonical(): string {
    const lines: string[] = []
    for (const f of this.db
      .prepare('SELECT root, path, hash, lang, bytes FROM files ORDER BY root, path')
      .all() as Omit<BrainFileRow, 'mtime' | 'gen'>[]) {
      lines.push('F ' + JSON.stringify(f))
    }
    for (const n of this.db
      .prepare('SELECT id, root, kind, name, file, startLine, endLine, sig FROM nodes ORDER BY root, id')
      .all() as BrainNodeRow[]) {
      lines.push('N ' + JSON.stringify(n))
    }
    for (const e of this.db
      .prepare('SELECT src, dst, kind, root FROM edges ORDER BY root, src, dst, kind')
      .all() as BrainEdgeRow[]) {
      lines.push('E ' + JSON.stringify(e))
    }
    return lines.join('\n') + '\n'
  }

  dispose(): void {
    this.db.close()
  }
}
