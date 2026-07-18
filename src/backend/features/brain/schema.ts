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

/** The graph tables (v2). files/nodes/edges are per-partition (keyed by root);
 *  parse_cache is global by construction. mtime/gen are the two VOLATILE columns —
 *  the canonical dump excludes them, everything else must reproduce byte-for-byte. */
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
