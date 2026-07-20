import { createHash } from 'node:crypto'

// The graph's shape (ADR 0018, step 03). Closed unions, stable ids, and DDL in ONE
// place — store.ts runs the versioned migration, extract.ts emits these rows, and
// the BRAINGRAPH gate's spine is that the same bytes always produce the same rows.
//
// Every graph row carries `root`: a project's worktrees each own a PARTITION in the
// same db, so sixteen checkouts can disagree without lying about it. parse_cache is
// deliberately root-FREE — it is content-addressed (lang, fileHash), so the second
// worktree's identical bytes are paid for once.

export const BRAIN_NODE_KINDS = [
  'module',
  'class',
  'interface',
  'type',
  'function',
  'method',
  'enum',
  'const'
] as const
export type BrainNodeKind = (typeof BRAIN_NODE_KINDS)[number]

export const BRAIN_EDGE_KINDS = ['defines', 'imports', 'references', 'extends', 'implements'] as const
export type BrainEdgeKind = (typeof BRAIN_EDGE_KINDS)[number]

export interface BrainFileRow {
  root: string
  /** Root-relative, '/'-separated on every OS — identical bytes must mean identical rows. */
  path: string
  /** sha256 of the file's bytes — the parse_cache key's second half. */
  hash: string
  lang: string
  bytes: number
  mtime: number
  gen: number
}

export interface BrainNodeRow {
  id: string
  root: string
  kind: BrainNodeKind
  name: string
  /** Root-relative path; '' for a package module node (it has no file). */
  file: string
  startLine: number
  endLine: number
  sig: string
}

export interface BrainEdgeRow {
  src: string
  dst: string
  kind: BrainEdgeKind
  root: string
}

/** The graph tables (v2+). files/nodes/edges are per-partition (keyed by root);
 *  parse_cache is global by construction. mtime/gen are the two VOLATILE columns —
 *  the canonical dump excludes them, everything else must reproduce byte-for-byte.
 *  v4 (ADR 0018/08) adds the library lens: lib_deps is per-partition lockfile
 *  truth; lib_docs is content-addressed like parse_cache — keyed (ecosystem,
 *  name, version), root-free, so one doc row serves every worktree pinning that
 *  version. Both are DERIVED (lockfiles + installed bytes) and excluded from the
 *  canonical dump like every other derived-when fact.
 *  v5 (ADR 0018/09) adds the memory lens: memories/memory_links are per-partition
 *  rows scanned from `.memory/*.md` (the files are the truth; these tables are
 *  disposable), and memories_fts is the FTS5 shadow the search verb ranks by
 *  (bm25 — deterministic arithmetic, never an opinion). Backlinks are DERIVED
 *  from memory_links, never stored in the files. All excluded from the
 *  canonical dump, exactly like the library lens.
 *  v6 (ADR 0018 revision A) adds memory_vectors: ONE row per written slug — the
 *  PROJECT'S freshest copy embedded under the workspace's own endpoint, keyed
 *  by contentHash (an unchanged memory never re-embeds) and stamped with the
 *  model that produced it (a model change invalidates honestly: the row is
 *  replaced on the next drain and never served under another model's name).
 *  Probabilistic state, doubly disposable — deleting the db loses nothing, and
 *  the deterministic lenses never read this table. Excluded from the canonical
 *  dump by nature.
 *  v7 (ADR 0018 revision B) adds the vault stance's two tables: memory_props is
 *  each memory's inert Obsidian-convention properties (sorted, capped rows the
 *  parse law already fixed); memory_scan is ONE row per root of honest skip
 *  counts (foreign_files because FOREIGN is SQLite-reserved) — what the flat
 *  scan refused to index, counted so the app can say so. Both are replaced
 *  whole per rescan, generation-neutral, and excluded from the canonical dump
 *  like the rest of the memory lens.
 *  v8 (ADR 0018 revision C) adds the draft quarantine's tables: memory_drafts
 *  mirrors memories for `.memory/drafts/` rows (plus the capture provenance —
 *  source, distilled — derived from the file's own props at scan time);
 *  memory_drafts_fts is its FTS5 shadow (searched SEPARATELY and ranked below
 *  curated, flagged on every hit); memory_draft_stats counts retention
 *  evictions per root (honesty accounting — the files are gone, the count is
 *  not). Drafts NEVER join memories/memory_links/memory_vectors: exclusion
 *  from suggestions, recall, and embedding is table topology, not discipline.
 *  v9 (ADR 0018 revision D) adds memory_usage: ONE row per slug of plain
 *  integer counters — how many times the memory rode a recall answer and how
 *  many times an agent read it in full. A DB COLUMN, never the file (usage is
 *  derived observation, not team knowledge); slug-keyed like memory_vectors
 *  (project-level — the freshest-copy election already unifies roots). The
 *  human reads it to prune; the app NEVER decays or deletes by it. Excluded
 *  from the canonical dump like every other derived-when fact. */
export const BRAIN_GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS files (
  root TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, lang TEXT NOT NULL,
  bytes INTEGER NOT NULL, mtime INTEGER NOT NULL, gen INTEGER NOT NULL,
  PRIMARY KEY (root, path)
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, root TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  file TEXT NOT NULL, startLine INTEGER NOT NULL, endLine INTEGER NOT NULL, sig TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_by_root ON nodes(root);
CREATE INDEX IF NOT EXISTS nodes_by_name ON nodes(root, name);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, root TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind, root)
);
CREATE INDEX IF NOT EXISTS edges_by_root ON edges(root);
CREATE INDEX IF NOT EXISTS edges_by_dst ON edges(dst);
CREATE TABLE IF NOT EXISTS parse_cache (
  lang TEXT NOT NULL, fileHash TEXT NOT NULL, nodesJson TEXT NOT NULL, edgesJson TEXT NOT NULL,
  PRIMARY KEY (lang, fileHash)
);
CREATE TABLE IF NOT EXISTS ranks (
  id TEXT PRIMARY KEY, root TEXT NOT NULL, rank REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ranks_by_root ON ranks(root);
CREATE TABLE IF NOT EXISTS lib_deps (
  root TEXT NOT NULL, ecosystem TEXT NOT NULL, name TEXT NOT NULL,
  version TEXT NOT NULL, pinned INTEGER NOT NULL, direct INTEGER NOT NULL,
  installed INTEGER NOT NULL, installedVersion TEXT NOT NULL,
  PRIMARY KEY (root, ecosystem, name)
);
CREATE TABLE IF NOT EXISTS lib_docs (
  ecosystem TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  source TEXT NOT NULL, readme TEXT NOT NULL, signatures TEXT NOT NULL,
  PRIMARY KEY (ecosystem, name, version)
);
CREATE TABLE IF NOT EXISTS memories (
  root TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  tags TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
  mtime INTEGER NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (root, slug)
);
CREATE TABLE IF NOT EXISTS memory_links (
  root TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
  PRIMARY KEY (root, src, dst)
);
CREATE INDEX IF NOT EXISTS memory_links_by_dst ON memory_links(dst);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, description, body, root UNINDEXED, slug UNINDEXED
);
CREATE TABLE IF NOT EXISTS memory_vectors (
  slug TEXT PRIMARY KEY, contentHash TEXT NOT NULL, model TEXT NOT NULL,
  dim INTEGER NOT NULL, vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_props (
  root TEXT NOT NULL, slug TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (root, slug, key)
);
CREATE TABLE IF NOT EXISTS memory_scan (
  root TEXT PRIMARY KEY, invalid INTEGER NOT NULL, too_large INTEGER NOT NULL,
  foreign_files INTEGER NOT NULL, capped INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_drafts (
  root TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  tags TEXT NOT NULL, source TEXT NOT NULL, distilled INTEGER NOT NULL,
  body TEXT NOT NULL, hash TEXT NOT NULL, mtime INTEGER NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (root, slug)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_drafts_fts USING fts5(
  name, description, body, root UNINDEXED, slug UNINDEXED
);
CREATE TABLE IF NOT EXISTS memory_draft_stats (
  root TEXT PRIMARY KEY, evicted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_usage (
  slug TEXT PRIMARY KEY, recalls INTEGER NOT NULL DEFAULT 0, reads INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS built_roots (
  root TEXT PRIMARY KEY
);
`

/** One node's repomap rank row (step 06) — written in the SAME transaction as the
 *  partition it ranks, which is what makes a stale rank impossible by
 *  construction. DERIVED (deterministically) from edges; excluded from the
 *  canonical dump like every other derived-when fact. */
export interface BrainRankRow {
  id: string
  rank: number
}

/** STABLE node identity: sha1 of (root, file, startLine, name, kind). Same bytes →
 *  same tree → same lines → same ids — which is what makes the canonical dump the
 *  determinism proof rather than a hope. */
export function brainNodeId(
  root: string,
  file: string,
  startLine: number,
  name: string,
  kind: BrainNodeKind
): string {
  return createHash('sha1').update(`${root}\0${file}\0${startLine}\0${name}\0${kind}`).digest('hex')
}

// ── The portable (content-addressed) half of extraction ─────────────────────────
// What parse_cache stores: everything a file's BYTES alone determine. No root, no
// absolute path, no ids — those are minted at insert time per partition, which is
// exactly why one cache row can serve sixteen worktrees.

export interface PortableDef {
  kind: BrainNodeKind
  name: string
  startLine: number
  endLine: number
  sig: string
}

export interface PortableImport {
  specifier: string
  /** Locally bound names (import scope for reference resolution). */
  names: string[]
}

export interface PortableRef {
  name: string
  line: number
}

export interface PortableHeritage {
  name: string
  kind: 'extends' | 'implements'
  /** Index into defs of the owning class — -1 when no owner was found. */
  ownerIndex: number
}

export interface PortableExtraction {
  defs: PortableDef[]
  imports: PortableImport[]
  refs: PortableRef[]
  heritage: PortableHeritage[]
}
