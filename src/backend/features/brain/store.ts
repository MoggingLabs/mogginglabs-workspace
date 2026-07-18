import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { requireNative } from '../../platform/native-require'
import { foldProjectKey } from '../workspace/project-identity'

// The per-project brain db (ADR 0018.b): DERIVED state under the app data dir —
// deletable, rebuildable, never in the repo. Same mechanism as every other store
// (better-sqlite3 through the host-aware seam, WAL), but this step the schema is
// `meta` ALONE: schema_version + generation. 03 owns the graph tables; the
// lifecycle laws land first so every later step inherits them instead of
// retrofitting them.

const Database = requireNative<typeof import('better-sqlite3')>('better-sqlite3')

export const BRAIN_SCHEMA_VERSION = 1

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
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta (schema_version INTEGER NOT NULL, generation INTEGER NOT NULL)'
    )
    const seeded = this.db.prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number }
    if (!seeded.n) {
      this.db
        .prepare('INSERT INTO meta (schema_version, generation) VALUES (?, 1)')
        .run(BRAIN_SCHEMA_VERSION)
    }
  }

  generation(): number {
    const row = this.db.prepare('SELECT generation FROM meta').get() as
      | { generation: number }
      | undefined
    return row?.generation ?? 1
  }

  /** A rebuild in a graph-less brain is pure lifecycle: the generation moves, and the
   *  (empty) derived state is by definition rebuilt. 03 hangs the real re-index here. */
  bumpGeneration(): number {
    this.db.prepare('UPDATE meta SET generation = generation + 1').run()
    return this.generation()
  }

  dispose(): void {
    this.db.close()
  }
}
