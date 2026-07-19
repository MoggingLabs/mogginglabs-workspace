import * as path from 'node:path'
import { BRAIN_LIB_ECOSYSTEMS, type BrainRefusal, type BrainStatus } from '@contracts'
import { foldProjectKey } from '../workspace/project-identity'
import { blobToVector, cosineSim } from './embed'
import {
  MEMORY_HYBRID_RRF_K,
  MEMORY_HYBRID_WEIGHTS,
  MEMORY_SUGGEST_WEIGHTS,
  isMemorySlug,
  memoryNameTerms,
  memorySearchExpr,
  memorySlug,
  parseMemoryFilter,
  type MemoryFilterClause
} from './memory'
import { REPOMAP_DEFAULT_BUDGET, REPOMAP_MAX_BUDGET, REPOMAP_MIN_BUDGET, renderRepoMap } from './render'
import { BRAIN_EDGE_KINDS, BRAIN_NODE_KINDS, type BrainNodeRow } from './schema'
import type { BrainStore } from './store'

// The brain MEETS the agents (ADR 0018, step 05): seven READ verbs behind the
// `brain.*` family on the house MCP server — free to every pane (ADR 0008's
// reads-free stance), scoped to the CALLER'S own checkout partition unless
// `scope: 'project'` opts into labeled cross-checkout reads. Every answer wears
// the `{ generation, dirty, root }` envelope (staleness visible THROUGH the
// tool), every list is capped and paged, every response is size-capped with the
// truncation FLAGGED (the no-silent-caps rule), and junk is a typed refusal in
// the board family's wording register — never a throw. WRITES DO NOT LIVE
// HERE: this module exposes nothing that mutates. The symbol-write family (07)
// is writes.ts — grant-gated, CAS-guarded, own-checkout only — and the catalog
// validator holds the brain's verbs to exactly the two closed sets.
//
// Electron-free: main hands in a BrainReadHost (the service) and the caller's
// resolved checkout root; symbol names and paths flow back to the CALLING MODEL
// only — never to telemetry (counts only, ADR 0005).

/** Page + walk caps: defaults small, maxima hard. */
export const BRAIN_SERVE_DEFAULT_LIMIT = 50
export const BRAIN_SERVE_MAX_LIMIT = 200
export const BRAIN_SERVE_MAX_DEPTH = 16
export const BRAIN_SERVE_DEFAULT_DEPTH = 8
/** BFS visited-set cap — past it the answer is a typed `too-deep`, never a stall. */
export const BRAIN_SERVE_VISITED_CAP = 4000
/** Per-node fan-out cap inside the BFS (a god-node counts against the walk). */
const BFS_FANOUT_CAP = 500
/** Whole-response byte cap. Trimming to fit SETS the truncated flag. */
export const BRAIN_SERVE_RESPONSE_CAP = 64 * 1024

/** What serve needs from the service — structural, so no import cycle exists. */
export interface BrainReadHost {
  readHandle(root: string): { project: { projectKey: string; roots: string[] }; store: BrainStore; status: BrainStatus } | BrainRefusal
}

export type BrainServeReply = Record<string, unknown> & { ok: boolean }

const refuse = (reason: string, detail?: string): BrainServeReply =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }

/** Glob (`*`/`?`) → SQL LIKE with `\` escapes. Anything else is literal. */
export function globToLike(glob: string): string {
  let out = ''
  for (const ch of glob) {
    if (ch === '*') out += '%'
    else if (ch === '?') out += '_'
    else if (ch === '%' || ch === '_' || ch === '\\') out += '\\' + ch
    else out += ch
  }
  return out
}

const hasGlob = (s: string): boolean => s.includes('*') || s.includes('?')

/** Opaque page cursor: versioned, offset-carrying. Junk decodes to null. */
const encodeCursor = (offset: number): string => Buffer.from(`b1:${offset}`, 'utf8').toString('base64url')
const decodeCursor = (cursor: string): number | null => {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const m = /^b1:(\d{1,9})$/.exec(raw)
    return m ? parseInt(m[1], 10) : null
  } catch {
    return null
  }
}

export interface NodeOut {
  id: string
  kind: string
  name: string
  file: string
  startLine: number
  endLine: number
  sig: string
  root?: string
}

export const nodeOut = (row: BrainNodeRow, labelRoot: boolean): NodeOut => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  file: row.file,
  startLine: row.startLine,
  endLine: row.endLine,
  sig: row.sig,
  ...(labelRoot ? { root: row.root } : {})
})

/** Trim a reply's list until the serialized answer fits the byte cap. Trimming
 *  is never silent: it sets `truncated`. */
function capReply(reply: BrainServeReply, listKey: string): BrainServeReply {
  const list = reply[listKey]
  if (!Array.isArray(list)) return reply
  while (list.length && JSON.stringify(reply).length > BRAIN_SERVE_RESPONSE_CAP) {
    list.pop()
    reply.truncated = true
  }
  return reply
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Positive-int arg with a clamp; undefined falls to the default; junk → null. */
function intArg(v: unknown, fallback: number, min: number, max: number): number | null {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  return n < min || n > max ? null : n
}

/** The caller's own PARTITION: the project root enclosing (or equal to) the
 *  caller's checkout root, in the ROOTS list's spelling — the same fold rule
 *  identity uses everywhere. Exported: the write family (07) anchors its
 *  own-checkout custody on the SAME resolution. */
export function partitionOf(roots: string[], base: string): string | null {
  const folded = foldProjectKey(path.resolve(base))
  let best: string | null = null
  for (const root of roots) {
    const fr = foldProjectKey(root)
    if (folded === fr || folded.startsWith(fr + path.sep) || folded.startsWith(fr + '/')) {
      if (!best || fr.length > foldProjectKey(best).length) best = root
    }
  }
  return best
}

interface ResolvedScope {
  store: BrainStore
  status: BrainStatus
  /** The caller's own partition root — the envelope's `root`, always. */
  caller: string
  /** Every root the project owns (the map's fallback pool; scope never widens it). */
  projectRoots: string[]
  projectKey: string
  /** The partitions this answer may read (caller-only, or the whole project). */
  roots: string[]
  /** TRUE = label every hit with its root (cross-checkout reads are never anonymous). */
  labeled: boolean
}

function resolveScope(
  host: BrainReadHost,
  args: Record<string, unknown>,
  callerRoot: string | null
): ResolvedScope | BrainServeReply {
  // A pane session's own checkout WINS — an explicit root is the bare-session
  // affordance (a human running the server outside any pane), never an escape.
  const base = callerRoot ?? str(args.root) ?? null
  if (!base) {
    return refuse('invalid', 'this session has no pane identity — pass an absolute "root" argument')
  }
  const scopeArg = args.scope
  if (scopeArg !== undefined && scopeArg !== 'checkout' && scopeArg !== 'project') {
    return refuse('invalid', 'scope must be "checkout" or "project"')
  }
  const h = host.readHandle(base)
  if ('reason' in h) return { ok: false, reason: h.reason, ...(h.detail ? { detail: h.detail } : {}) }
  const caller = partitionOf(h.project.roots, base) ?? h.project.projectKey
  const project = scopeArg === 'project'
  return {
    store: h.store,
    status: h.status,
    caller,
    projectRoots: [...h.project.roots],
    projectKey: h.project.projectKey,
    roots: project ? [...h.project.roots] : [caller],
    labeled: project
  }
}

const envelope = (s: ResolvedScope): { generation: number; dirty: boolean; root: string } => ({
  generation: s.status.generation,
  dirty: s.status.dirty,
  root: s.caller
})

/** A node the caller may see: it exists AND lives in an allowed partition.
 *  Everything else is ONE answer — `unknown-node` — mirroring the board's
 *  unknown-card wording: what you cannot see, you cannot distinguish. */
function visibleNode(s: ResolvedScope, id: string): BrainNodeRow | null {
  const row = s.store.nodeById(id)
  if (!row) return null
  const fr = foldProjectKey(row.root)
  return s.roots.some((r) => foldProjectKey(r) === fr) ? row : null
}

const unknownNode = (id: string): BrainServeReply =>
  refuse('unknown-node', `unknown node ${id} (not in your project's brain)`)

// ── The seven ────────────────────────────────────────────────────────────────

function serveStatus(s: ResolvedScope): BrainServeReply {
  const { ok: _ok, ...status } = s.status
  return { ok: true, ...envelope(s), status }
}

function serveQuery(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const kind = str(args.kind)
  if (kind !== undefined && !(BRAIN_NODE_KINDS as readonly string[]).includes(kind)) {
    return refuse('invalid', `kind must be one of: ${BRAIN_NODE_KINDS.join(', ')}`)
  }
  const limit = intArg(args.limit, BRAIN_SERVE_DEFAULT_LIMIT, 1, BRAIN_SERVE_MAX_LIMIT)
  if (limit === null) return refuse('invalid', `limit must be 1-${BRAIN_SERVE_MAX_LIMIT}`)
  let offset = 0
  if (args.cursor !== undefined) {
    const decoded = typeof args.cursor === 'string' ? decodeCursor(args.cursor) : null
    if (decoded === null) return refuse('invalid', 'cursor is not one this server issued')
    offset = decoded
  }
  const name = str(args.name)
  const file = str(args.file)
  const page = s.store.nodesPage(
    s.roots,
    {
      ...(kind ? { kind } : {}),
      ...(name !== undefined ? { nameLike: globToLike(name) } : {}),
      ...(file !== undefined ? { fileLike: globToLike(file) } : {})
    },
    limit,
    offset
  )
  const reply: BrainServeReply = {
    ok: true,
    ...envelope(s),
    nodes: page.rows.map((r) => nodeOut(r, s.labeled)),
    truncated: page.more,
    ...(page.more ? { cursor: encodeCursor(offset + page.rows.length) } : {})
  }
  return capReply(reply, 'nodes')
}

function serveNode(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const id = str(args.id)
  if (!id) return refuse('invalid', 'id is required')
  const row = visibleNode(s, id)
  if (!row) return unknownNode(id)
  // fileHash: the file's sha256 as last INDEXED — the expectedFileHash a symbol
  // write (07) compare-and-swaps against. Package modules have no file, no hash.
  const fileRow = row.file ? s.store.fileRow(row.root, row.file) : null
  return { ok: true, ...envelope(s), node: nodeOut(row, s.labeled), ...(fileRow ? { fileHash: fileRow.hash } : {}) }
}

function serveNeighbors(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const id = str(args.id)
  if (!id) return refuse('invalid', 'id is required')
  const direction = args.direction
  if (direction !== 'in' && direction !== 'out' && direction !== 'both') {
    return refuse('invalid', 'direction must be in, out, or both')
  }
  let kinds: string[] | null = null
  if (args.kinds !== undefined) {
    if (typeof args.kinds !== 'string') return refuse('invalid', 'kinds must be a comma-separated string')
    kinds = args.kinds.split(',').map((k) => k.trim()).filter(Boolean)
    const bad = kinds.find((k) => !(BRAIN_EDGE_KINDS as readonly string[]).includes(k))
    if (bad !== undefined) return refuse('invalid', `unknown edge kind "${bad}" (allowed: ${BRAIN_EDGE_KINDS.join(', ')})`)
    if (!kinds.length) kinds = null
  }
  const limit = intArg(args.limit, BRAIN_SERVE_DEFAULT_LIMIT, 1, BRAIN_SERVE_MAX_LIMIT)
  if (limit === null) return refuse('invalid', `limit must be 1-${BRAIN_SERVE_MAX_LIMIT}`)
  const row = visibleNode(s, id)
  if (!row) return unknownNode(id)
  const touching = s.store.edgesTouching(id, direction, kinds, limit + 1)
  const more = touching.length > limit
  const page = touching.slice(0, limit)
  const peers = new Map(s.store.nodesByIds([...new Set(page.map((t) => (t.dir === 'out' ? t.edge.dst : t.edge.src)))]).map((n) => [n.id, n]))
  const neighbors = []
  for (const t of page) {
    const peerId = t.dir === 'out' ? t.edge.dst : t.edge.src
    const peer = peers.get(peerId)
    if (!peer) continue // a dangling edge answers nothing rather than a ghost
    neighbors.push({ node: nodeOut(peer, s.labeled), edge: { kind: t.edge.kind, direction: t.dir } })
  }
  return capReply({ ok: true, ...envelope(s), neighbors, truncated: more }, 'neighbors')
}

function servePath(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const fromId = str(args.from)
  const toId = str(args.to)
  if (!fromId || !toId) return refuse('invalid', 'from and to are required')
  const maxDepth = intArg(args.maxDepth, BRAIN_SERVE_DEFAULT_DEPTH, 1, BRAIN_SERVE_MAX_DEPTH)
  if (maxDepth === null) return refuse('invalid', `maxDepth must be 1-${BRAIN_SERVE_MAX_DEPTH}`)
  const from = visibleNode(s, fromId)
  if (!from) return unknownNode(fromId)
  const to = visibleNode(s, toId)
  if (!to) return unknownNode(toId)
  if (fromId === toId) return { ok: true, ...envelope(s), found: true, depth: 0, nodes: [nodeOut(from, s.labeled)], edges: [] }
  // Partitions never share an edge, so a cross-checkout pair is honestly unconnected.
  if (foldProjectKey(from.root) !== foldProjectKey(to.root)) {
    return { ok: true, ...envelope(s), found: false, depth: 0, nodes: [], edges: [] }
  }

  // BFS over an undirected view of the edges, capped twice: depth and visited.
  // Hitting a cap with ground still unexplored is a typed `too-deep` — a walk
  // that EXHAUSTED the component without finding `to` answers found:false.
  const parent = new Map<string, { prev: string; edge: { src: string; dst: string; kind: string } }>()
  const seen = new Set<string>([fromId])
  let frontier = [fromId]
  let depth = 0
  let capped = false
  let found = false
  while (frontier.length && depth < maxDepth && !found) {
    depth += 1
    const next: string[] = []
    for (const id of frontier) {
      const touching = s.store.edgesTouching(id, 'both', null, BFS_FANOUT_CAP + 1)
      if (touching.length > BFS_FANOUT_CAP) capped = true
      for (const t of touching.slice(0, BFS_FANOUT_CAP)) {
        const peer = t.dir === 'out' ? t.edge.dst : t.edge.src
        if (seen.has(peer)) continue
        seen.add(peer)
        parent.set(peer, { prev: id, edge: { src: t.edge.src, dst: t.edge.dst, kind: t.edge.kind } })
        if (peer === toId) {
          found = true
          break
        }
        next.push(peer)
      }
      if (found) break
      if (seen.size > BRAIN_SERVE_VISITED_CAP) {
        return refuse('too-deep', `the walk exceeded its caps (depth ${depth}, ${seen.size} nodes visited) before reaching the target`)
      }
    }
    frontier = next
  }
  if (!found) {
    if (frontier.length || capped) {
      // Unexplored ground remained when the caps closed the walk: refusing is
      // the honest answer — "not found" would claim more than the walk proved.
      return refuse('too-deep', `no path within maxDepth ${maxDepth} — unexplored edges remained (raise maxDepth, up to ${BRAIN_SERVE_MAX_DEPTH})`)
    }
    return { ok: true, ...envelope(s), found: false, depth: 0, nodes: [], edges: [] }
  }
  // Reconstruct target → source, then flip.
  const chainIds: string[] = [toId]
  const chainEdges: { src: string; dst: string; kind: string }[] = []
  let cursor = toId
  while (cursor !== fromId) {
    const step = parent.get(cursor)
    if (!step) return refuse('too-deep', 'the path could not be reconstructed') // unreachable by construction
    chainEdges.push(step.edge)
    cursor = step.prev
    chainIds.push(cursor)
  }
  chainIds.reverse()
  chainEdges.reverse()
  const byId = new Map(s.store.nodesByIds(chainIds).map((n) => [n.id, n]))
  return capReply(
    {
      ok: true,
      ...envelope(s),
      found: true,
      depth: chainEdges.length,
      nodes: chainIds.map((id) => {
        const n = byId.get(id)
        return n ? nodeOut(n, s.labeled) : { id }
      }),
      edges: chainEdges
    },
    'nodes'
  )
}

function serveSymbol(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const name = str(args.name)
  if (!name) return refuse('invalid', 'name is required')
  const kind = str(args.kind)
  if (kind !== undefined && !(BRAIN_NODE_KINDS as readonly string[]).includes(kind)) {
    return refuse('invalid', `kind must be one of: ${BRAIN_NODE_KINDS.join(', ')}`)
  }
  // Exact first; a glob (or a miss retried AS a glob) second — never both mixed.
  const exact = hasGlob(name) ? [] : s.store.nodesByExactName(s.roots, name, kind)
  let matchedBy: 'exact' | 'glob' = 'exact'
  let rows = exact
  let more = false
  if (!rows.length) {
    matchedBy = 'glob'
    const page = s.store.nodesPage(
      s.roots,
      { nameLike: globToLike(name), ...(kind ? { kind } : {}) },
      BRAIN_SERVE_MAX_LIMIT,
      0
    )
    rows = page.rows
    more = page.more
  } else if (rows.length > BRAIN_SERVE_MAX_LIMIT) {
    rows = rows.slice(0, BRAIN_SERVE_MAX_LIMIT)
    more = true
  }
  return capReply(
    { ok: true, ...envelope(s), matches: rows.map((r) => nodeOut(r, s.labeled)), matchedBy, truncated: more },
    'matches'
  )
}

function serveReferences(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const id = str(args.id)
  const name = str(args.name)
  if (!id && !name) return refuse('invalid', 'one of "id" or "name" is required')
  let targets: BrainNodeRow[]
  if (id) {
    const row = visibleNode(s, id)
    if (!row) return unknownNode(id)
    targets = [row]
  } else {
    targets = s.store.nodesByExactName(s.roots, name as string, undefined)
    if (!targets.length) return refuse('unknown-node', `no definition named ${name} (not in your project's brain)`)
  }
  const edges = s.store.referencesInto(targets.map((t) => t.id), BRAIN_SERVE_MAX_LIMIT + 1)
  const more = edges.length > BRAIN_SERVE_MAX_LIMIT
  const page = edges.slice(0, BRAIN_SERVE_MAX_LIMIT)
  const sources = new Map(s.store.nodesByIds([...new Set(page.map((e) => e.src))]).map((n) => [n.id, n]))
  const references = []
  for (const e of page) {
    const src = sources.get(e.src)
    if (src) references.push({ node: nodeOut(src, s.labeled), to: e.dst })
  }
  const dropped = s.status.droppedRefs
  return capReply(
    {
      ok: true,
      ...envelope(s),
      targets: targets.map((t) => nodeOut(t, s.labeled)),
      references,
      truncated: more,
      ...(dropped > 0
        ? { note: `${dropped} ambiguous reference${dropped === 1 ? ' was' : 's were'} dropped at index time (fidelity reported, never faked) — this list is the resolved truth and may be incomplete.` }
        : {})
    },
    'references'
  )
}

function serveMap(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const budget = intArg(args.budget, REPOMAP_DEFAULT_BUDGET, REPOMAP_MIN_BUDGET, REPOMAP_MAX_BUDGET)
  if (budget === null) return refuse('invalid', `budget must be ${REPOMAP_MIN_BUDGET}-${REPOMAP_MAX_BUDGET} characters`)
  // The map orients the caller's OWN checkout. A freshly minted worktree's
  // partition is honestly empty (nothing indexed it yet) — orientation then
  // falls back to the project's OTHER built partitions (projectKey first):
  // same project, same shapes, and the stamp still says which generation. The
  // fallback pool is the project's roots and nothing wider — custody holds.
  let mapRoot = s.caller
  let rows = s.store.repoMapRows(mapRoot)
  if (!rows.length) {
    for (const candidate of [s.projectKey, ...s.projectRoots]) {
      if (foldProjectKey(candidate) === foldProjectKey(s.caller)) continue
      rows = s.store.repoMapRows(candidate)
      if (rows.length) {
        mapRoot = candidate
        break
      }
    }
  }
  if (!rows.length) {
    return refuse('no-map', 'no brain index for this checkout — run brain:rebuild (or open the project) first')
  }
  const totalFiles = s.store.partitionCounts(mapRoot).files
  const map = renderRepoMap(rows, { budget, generation: s.status.generation, totalFiles })
  return { ok: true, ...envelope(s), map, mapRoot, budget }
}

// ── The library lens (08): version truth + docs custody, cache reads only ────

function serveLibraries(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const eco = str(args.ecosystem)
  if (eco !== undefined && !(BRAIN_LIB_ECOSYSTEMS as readonly string[]).includes(eco)) {
    return refuse('invalid', `ecosystem must be one of: ${BRAIN_LIB_ECOSYSTEMS.join(', ')}`)
  }
  const rows = s.store.libRows(s.caller, eco)
  const reply: BrainServeReply = {
    ok: true,
    ...envelope(s),
    libraries: rows.map((r) => ({
      ecosystem: r.ecosystem,
      name: r.name,
      version: r.version,
      pinned: !!r.pinned,
      direct: !!r.direct,
      installed: !!r.installed,
      ...(r.installedVersion && r.installedVersion !== r.version ? { installedVersion: r.installedVersion } : {}),
      hasDocs: !!r.hasDocs
    })),
    truncated: false
  }
  return capReply(reply, 'libraries')
}

/** README sections whose heading matches `topic` (case-insensitive substring).
 *  Preamble before the first heading stays only when nothing matched at all. */
function filterReadmeByTopic(readme: string, topic: string): { text: string; matched: boolean } {
  const needle = topic.toLowerCase()
  const lines = readme.split('\n')
  const out: string[] = []
  let keeping = false
  let matched = false
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      keeping = heading[1].toLowerCase().includes(needle)
      if (keeping) matched = true
    }
    if (keeping) out.push(line)
  }
  return { text: out.join('\n'), matched }
}

function serveLibDocs(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const name = str(args.name)
  if (!name) return refuse('invalid', 'name is required')
  const eco = str(args.ecosystem)
  if (eco !== undefined && !(BRAIN_LIB_ECOSYSTEMS as readonly string[]).includes(eco)) {
    return refuse('invalid', `ecosystem must be one of: ${BRAIN_LIB_ECOSYSTEMS.join(', ')}`)
  }
  const dep = s.store.libDep(s.caller, name, eco)
  if (!dep) {
    // A key lookup, never a path: hostile names refuse here, canonically.
    return refuse('unknown-library', `unknown library ${name.slice(0, 120)} (not in this checkout's lockfiles or manifests — see list_libraries)`)
  }
  const base = {
    ok: true as const,
    ...envelope(s),
    ecosystem: dep.ecosystem,
    name: dep.name,
    version: dep.version,
    pinned: !!dep.pinned,
    installed: !!dep.installed,
    ...(dep.installedVersion && dep.installedVersion !== dep.version ? { installedVersion: dep.installedVersion } : {})
  }
  // The reference law, read-side: a pinned dep serves ONLY its pinned version's
  // docs; a range serves what the disk holds. Version-correct or version-silent.
  const doc = dep.pinned
    ? s.store.libDoc(dep.ecosystem, dep.name, dep.version)
    : dep.installedVersion
      ? s.store.libDoc(dep.ecosystem, dep.name, dep.installedVersion)
      : null
  if (!doc) {
    return {
      ...base,
      hasDocs: false,
      note: dep.pinned
        ? 'no docs cached for this version — the pinned version is not on disk. Install it, or retry with fetch:true (needs this workspace\'s library-docs permission).'
        : 'no docs cached — nothing pins this dependency to an exact version, and an unversioned doc answer does not exist. Install or pin it first.'
    }
  }
  let meta: { exports?: string[]; sigs?: string[]; readmeTruncated?: boolean } = {}
  try {
    meta = JSON.parse(doc.signatures) as typeof meta
  } catch {
    /* a corrupt row serves its readme; signatures degrade to empty */
  }
  const topic = str(args.topic)
  let readme = doc.readme
  let topicMatched: boolean | undefined
  if (topic !== undefined) {
    const filtered = filterReadmeByTopic(doc.readme, topic)
    readme = filtered.text
    topicMatched = filtered.matched
  }
  // The version stamp is the DOC's — the release these bytes actually describe.
  const reply: BrainServeReply = {
    ...base,
    hasDocs: true,
    version: doc.version,
    source: doc.source,
    readme,
    exports: meta.exports ?? [],
    signatures: meta.sigs ?? [],
    truncated: meta.readmeTruncated === true,
    ...(topicMatched === false ? { note: 'no README section matched that topic — the full README is still served without a topic filter' } : {})
  }
  // Fit the byte cap by trimming signatures first, then the README — flagged.
  capReply(reply, 'signatures')
  while (typeof reply.readme === 'string' && reply.readme.length && JSON.stringify(reply).length > BRAIN_SERVE_RESPONSE_CAP) {
    reply.readme = reply.readme.slice(0, Math.floor(reply.readme.length / 2))
    reply.truncated = true
  }
  return reply
}

// ── The memory lens (09): the team's wikilink graph, read project-wide ───────
// Memories live per checkout but READ project-wide by LAW (ADR 0018.i): the
// freshest indexed copy across the project's roots wins, and every answer is
// root-labeled — a cross-checkout memory is never anonymous. There is no scope
// argument here on purpose: narrowing would hide a teammate's fresher copy.

export const MEMORY_SEARCH_DEFAULT_LIMIT = 20
export const MEMORY_SEARCH_MAX_LIMIT = 100
export const MEMORY_SUGGEST_DEFAULT_LIMIT = 10
export const MEMORY_SUGGEST_MAX_LIMIT = 50
/** Raw FTS rows fetched before the freshest-copy dedupe — a hard read cap. */
const MEMORY_SEARCH_FETCH_CAP = 400

const parseTags = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** The freshest copy wins; an mtime TIE falls to project-roots order (projectKey
 *  first) — fixed, so the same rows always elect the same copy. */
function freshestMemory<T extends { root: string; mtime: number }>(copies: T[], roots: string[]): T {
  const rank = new Map(roots.map((r, i) => [foldProjectKey(r), i]))
  return [...copies].sort(
    (a, b) =>
      b.mtime - a.mtime ||
      (rank.get(foldProjectKey(a.root)) ?? roots.length) - (rank.get(foldProjectKey(b.root)) ?? roots.length)
  )[0]
}

/** slug arg → the slug, or a refusal that TEACHES (the sanitized spelling rides
 *  the refusal when one exists). */
function slugArg(v: unknown): { slug: string } | BrainServeReply {
  const raw = str(v)
  if (!raw) return refuse('invalid', 'slug is required')
  if (!isMemorySlug(raw)) {
    const norm = memorySlug(raw)
    return refuse('invalid', norm ? `"${raw.slice(0, 80)}" is not a slug — did you mean "${norm}"?` : 'slug must be kebab-case (a-z, 0-9, dashes)')
  }
  return { slug: raw }
}

/** slug → its freshest copy, for every written slug in scope. Exported: the
 *  embed drain (revision A) must elect the SAME copy every read serves. */
export function freshestBySlug<T extends { slug: string; root: string; mtime: number }>(rows: T[], roots: string[]): Map<string, T> {
  const grouped = new Map<string, T[]>()
  for (const r of rows) {
    const list = grouped.get(r.slug) ?? []
    list.push(r)
    grouped.set(r.slug, list)
  }
  return new Map([...grouped.entries()].map(([slug, copies]) => [slug, freshestMemory(copies, roots)]))
}

/** The `filter` arg (revision B): absent → null; junk → a typed, teaching
 *  refusal. The grammar is CLOSED — parseMemoryFilter speaks its primitives. */
function filterArg(v: unknown): { clauses: MemoryFilterClause[] | null } | BrainServeReply {
  if (v === undefined) return { clauses: null }
  if (typeof v !== 'string' || !v) {
    return refuse('invalid', 'filter must be a non-empty string — clauses are #tag, key, or key=value (comma-joined AND, max 8)')
  }
  const parsed = parseMemoryFilter(v)
  if ('error' in parsed) return refuse('invalid', parsed.error)
  return { clauses: parsed.clauses }
}

/** The slugs whose FRESHEST copy satisfies every clause — the same election
 *  every read serves, evaluated BEFORE any ranking (revision B's one law). */
function memoryFilterEligible(s: ResolvedScope, clauses: MemoryFilterClause[]): Set<string> {
  const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
  const propsBy = new Map<string, Map<string, string>>()
  for (const p of s.store.memoryPropsForRoots(s.projectRoots)) {
    const key = `${foldProjectKey(p.root)}\0${p.slug}`
    const m = propsBy.get(key) ?? new Map<string, string>()
    m.set(p.key, p.value)
    propsBy.set(key, m)
  }
  const eligible = new Set<string>()
  for (const [slug, row] of written) {
    const props = propsBy.get(`${foldProjectKey(row.root)}\0${slug}`) ?? new Map<string, string>()
    const tags = new Set(parseTags(row.tags))
    const pass = clauses.every((c) =>
      c.kind === 'tag' ? tags.has(c.tag) : c.kind === 'has' ? props.has(c.key) : props.get(c.key) === c.value
    )
    if (pass) eligible.add(slug)
  }
  return eligible
}

function serveMemorySearch(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const query = str(args.query)
  if (!query) return refuse('invalid', 'query is required')
  const limit = intArg(args.limit, MEMORY_SEARCH_DEFAULT_LIMIT, 1, MEMORY_SEARCH_MAX_LIMIT)
  if (limit === null) return refuse('invalid', `limit must be 1-${MEMORY_SEARCH_MAX_LIMIT}`)
  const f = filterArg(args.filter)
  if ('ok' in f) return f
  const expr = memorySearchExpr(query)
  if (!expr) return refuse('invalid', 'the query has no searchable terms')
  const hits = s.store.memorySearch(s.projectRoots, expr, MEMORY_SEARCH_FETCH_CAP)
  // The filter narrows the CANDIDATES before any ranking; zero matches is an
  // honest ok + empty list, never an error. Filter absent = byte-identical.
  const eligible = f.clauses ? memoryFilterEligible(s, f.clauses) : null
  const considered = eligible ? hits.filter((h) => eligible.has(h.slug)) : hits
  // Dedupe by slug — among the copies that MATCHED, the freshest wins and keeps
  // its own bm25 rank; the final order is (rank asc, slug asc), fixed.
  const kept = [...freshestBySlug(considered, s.projectRoots).values()].sort(
    (a, b) => a.rank - b.rank || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  )
  const page = kept.slice(0, limit)
  return capReply(
    {
      ok: true,
      ...envelope(s),
      memories: page.map((h) => ({
        slug: h.slug,
        name: h.name,
        description: h.description,
        tags: parseTags(h.tags),
        root: h.root
      })),
      truncated: kept.length > limit || hits.length >= MEMORY_SEARCH_FETCH_CAP
    },
    'memories'
  )
}

function serveMemoryGet(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const a = slugArg(args.slug)
  if ('ok' in a) return a
  const copies = s.store.memoryCopies(s.projectRoots, a.slug)
  const allLinks = s.store.memoryLinks(s.projectRoots)
  if (!copies.length) {
    const sources = new Set(allLinks.filter((l) => l.dst === a.slug).map((l) => l.src))
    return refuse(
      'unknown-memory',
      sources.size
        ? `no memory "${a.slug}" is written yet, but ${sources.size} memor${sources.size === 1 ? 'y links' : 'ies link'} to it — a dangling target marking wanted knowledge (find_backlinks lists the linkers)`
        : `unknown memory ${a.slug} (not in this project's .memory/)`
    )
  }
  const m = freshestMemory(copies, s.projectRoots)
  const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
  const mFold = foldProjectKey(m.root)
  const links = [...new Set(allLinks.filter((l) => foldProjectKey(l.root) === mFold && l.src === a.slug).map((l) => l.dst))]
    .sort()
    .map((dst) => ({ slug: dst, dangling: !written.has(dst) }))
  const backlinks = [...new Set(allLinks.filter((l) => l.dst === a.slug).map((l) => l.src))].sort().map((src) => ({
    slug: src,
    root: written.get(src)?.root ?? m.root
  }))
  const reply: BrainServeReply = {
    ok: true,
    ...envelope(s),
    memory: {
      slug: m.slug,
      name: m.name,
      description: m.description,
      tags: parseTags(m.tags),
      // Revision B: the freshest copy's properties — key-sorted, inert bytes.
      properties: Object.fromEntries(s.store.memoryProps(m.root, a.slug).map((p) => [p.key, p.value])),
      body: m.body,
      root: m.root,
      // The CAS handshake: update_memory compare-and-swaps against exactly this.
      fileHash: m.hash,
      mtime: m.mtime
    },
    links,
    backlinks,
    truncated: false
  }
  // Fit the byte cap by halving the body — flagged, like every other trim.
  const mem = reply.memory as { body: string }
  while (mem.body.length && JSON.stringify(reply).length > BRAIN_SERVE_RESPONSE_CAP) {
    mem.body = mem.body.slice(0, Math.floor(mem.body.length / 2))
    reply.truncated = true
  }
  return reply
}

function serveMemoryBacklinks(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const a = slugArg(args.slug)
  if ('ok' in a) return a
  const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
  const allLinks = s.store.memoryLinks(s.projectRoots)
  const backlinks = [...new Set(allLinks.filter((l) => l.dst === a.slug).map((l) => l.src))].sort().map((src) => ({
    slug: src,
    root: written.get(src)?.root ?? s.caller
  }))
  // A dangling TARGET is still queryable — that is the whole point of letting
  // links precede their memories: `exists:false` + backlinks = wanted knowledge.
  return capReply(
    { ok: true, ...envelope(s), slug: a.slug, exists: written.has(a.slug), backlinks, truncated: false },
    'backlinks'
  )
}

function serveMemorySuggest(s: ResolvedScope, args: Record<string, unknown>): BrainServeReply {
  const a = slugArg(args.slug)
  if ('ok' in a) return a
  const limit = intArg(args.limit, MEMORY_SUGGEST_DEFAULT_LIMIT, 1, MEMORY_SUGGEST_MAX_LIMIT)
  if (limit === null) return refuse('invalid', `limit must be 1-${MEMORY_SUGGEST_MAX_LIMIT}`)
  const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
  const me = written.get(a.slug)
  if (!me) return refuse('unknown-memory', `unknown memory ${a.slug} (not in this project's .memory/) — suggestions need a written source`)
  const allLinks = s.store.memoryLinks(s.projectRoots)
  // Each slug's OUTGOING set comes from its freshest copy's partition — the same
  // copy every other read serves, so suggest never scores a stale edge.
  const outgoing = new Map<string, Set<string>>()
  for (const [slug, row] of written) {
    const fold = foldProjectKey(row.root)
    outgoing.set(slug, new Set(allLinks.filter((l) => l.src === slug && foldProjectKey(l.root) === fold).map((l) => l.dst)))
  }
  const mine = outgoing.get(a.slug) ?? new Set<string>()
  const myTags = new Set(parseTags(me.tags))
  const myTerms = new Set(memoryNameTerms(me.name))
  const suggestions: { slug: string; root: string; score: number; breakdown: Record<string, unknown> }[] = []
  for (const [slug, row] of written) {
    if (slug === a.slug) continue
    const theirs = outgoing.get(slug) ?? new Set<string>()
    if (mine.has(slug) || theirs.has(a.slug)) continue // already connected — a suggestion would be noise
    const sharedLinks = [...theirs].filter((d) => mine.has(d)).sort()
    const sharedTags = parseTags(row.tags).filter((t) => myTags.has(t)).sort()
    const sharedTerms = memoryNameTerms(row.name).filter((t) => myTerms.has(t)).sort()
    const score =
      MEMORY_SUGGEST_WEIGHTS.link * sharedLinks.length +
      MEMORY_SUGGEST_WEIGHTS.tag * sharedTags.length +
      MEMORY_SUGGEST_WEIGHTS.term * sharedTerms.length
    if (score <= 0) continue
    suggestions.push({
      slug,
      root: row.root,
      score,
      // The breakdown IS the audit: fixed weights, listed evidence, no opinion.
      breakdown: { sharedLinks, sharedTags, sharedTerms, weights: MEMORY_SUGGEST_WEIGHTS }
    })
  }
  suggestions.sort((x, y) => y.score - x.score || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0))
  return capReply(
    {
      ok: true,
      ...envelope(s),
      slug: a.slug,
      suggestions: suggestions.slice(0, limit),
      truncated: suggestions.length > limit
    },
    'suggestions'
  )
}

// ── The semantic lens (ADR 0018 revision A): probabilistic, labeled, opt-in ──
// This function is NOT in serveBrainRead's dispatch on purpose: the sync
// deterministic path never learns the lens exists. Main calls it only after
// the workspace's consent, endpoint, and query embedding all resolved — and
// every hit it emits wears `probabilistic: true` with its provider and model,
// because an unlabeled probabilistic answer is a review rejection by law.

export interface MemorySemanticLens {
  mode: 'semantic' | 'hybrid'
  /** The query's embedding, already L2-normalized (main embeds per call). */
  queryVec: Float32Array
  /** The endpoint's host label + the model that produced the vectors. */
  provider: string
  model: string
}

export function serveMemorySearchSemantic(
  host: BrainReadHost,
  args: Record<string, unknown>,
  callerRoot: string | null,
  lens: MemorySemanticLens
): BrainServeReply {
  try {
    const s0 = resolveScope(host, args, callerRoot)
    if ('ok' in s0) return s0
    const s = s0
    const query = str(args.query)
    if (!query) return refuse('invalid', 'query is required')
    const limit = intArg(args.limit, MEMORY_SEARCH_DEFAULT_LIMIT, 1, MEMORY_SEARCH_MAX_LIMIT)
    if (limit === null) return refuse('invalid', `limit must be 1-${MEMORY_SEARCH_MAX_LIMIT}`)
    const f = filterArg(args.filter)
    if ('ok' in f) return f

    const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
    // Revision B: the filter narrows the CANDIDATE SET before either ranking
    // exists — the cosine list and the FTS list are both built filtered, so
    // every rank (and the RRF blend of them) is a rank WITHIN the filtered set.
    const eligible = f.clauses ? memoryFilterEligible(s, f.clauses) : null
    if (eligible) {
      for (const slug of [...written.keys()]) {
        if (!eligible.has(slug)) written.delete(slug)
      }
    }
    // Only the CURRENT model's rows exist here (store filters): a model swap
    // invalidates every older vector without a flag to forget.
    const vectors = new Map<string, Float32Array>()
    for (const row of s.store.memoryVectorRows(lens.model)) {
      if (!written.has(row.slug)) continue
      const vec = blobToVector(row.vec, row.dim)
      if (vec) vectors.set(row.slug, vec)
    }
    const unembedded = written.size - vectors.size

    // The cosine list: score desc, slug asc — fixed, like every house order.
    const semRanked = [...vectors.entries()]
      .map(([slug, vec]) => ({ slug, score: cosineSim(lens.queryVec, vec) }))
      .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))

    const hitOf = (slug: string): Record<string, unknown> => {
      const m = written.get(slug) as { slug: string; name: string; description: string; tags: string; root: string }
      return {
        slug: m.slug,
        name: m.name,
        description: m.description,
        tags: parseTags(m.tags),
        root: m.root,
        // The lens law's label, load-bearing: this answer is an OPINION, and it
        // says whose.
        probabilistic: true,
        provider: lens.provider,
        model: lens.model
      }
    }

    if (lens.mode === 'semantic') {
      const page = semRanked.slice(0, limit)
      return capReply(
        {
          ok: true,
          ...envelope(s),
          mode: 'semantic',
          memories: page.map((r) => ({ ...hitOf(r.slug), score: r.score })),
          truncated: semRanked.length > limit,
          ...(unembedded > 0 ? { unembedded } : {})
        },
        'memories'
      )
    }

    // Hybrid: the exact verb's own FTS list (freshest-copy deduped, same order)
    // fused with the cosine list by fixed-weight reciprocal rank — the two
    // components SUM to the score, and the breakdown rides every hit.
    const expr = memorySearchExpr(query)
    const ftsHits = expr ? s.store.memorySearch(s.projectRoots, expr, MEMORY_SEARCH_FETCH_CAP) : []
    const ftsKept = [
      ...freshestBySlug(eligible ? ftsHits.filter((h) => eligible.has(h.slug)) : ftsHits, s.projectRoots).values()
    ].sort((a, b) => a.rank - b.rank || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    const ftsRank = new Map(ftsKept.map((r, i) => [r.slug, i + 1]))
    const semRank = new Map(semRanked.map((r, i) => [r.slug, i + 1]))
    const blended = [...new Set([...ftsRank.keys(), ...semRank.keys()])]
      .map((slug) => {
        const f = ftsRank.get(slug)
        const v = semRank.get(slug)
        const ftsComponent = f === undefined ? 0 : MEMORY_HYBRID_WEIGHTS.fts / (MEMORY_HYBRID_RRF_K + f)
        const semComponent = v === undefined ? 0 : MEMORY_HYBRID_WEIGHTS.semantic / (MEMORY_HYBRID_RRF_K + v)
        return { slug, score: ftsComponent + semComponent, ftsComponent, semComponent, f: f ?? null, v: v ?? null }
      })
      .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    const page = blended.slice(0, limit)
    return capReply(
      {
        ok: true,
        ...envelope(s),
        mode: 'hybrid',
        memories: page.map((r) => ({
          ...hitOf(r.slug),
          score: r.score,
          breakdown: {
            ftsRank: r.f,
            semRank: r.v,
            ftsComponent: r.ftsComponent,
            semComponent: r.semComponent,
            weights: MEMORY_HYBRID_WEIGHTS,
            k: MEMORY_HYBRID_RRF_K
          }
        })),
        truncated: blended.length > limit,
        ...(unembedded > 0 ? { unembedded } : {})
      },
      'memories'
    )
  } catch (e) {
    return refuse('busy', e instanceof Error ? e.message : String(e))
  }
}

/**
 * The one dispatch. `callerRoot` is the pane's resolved checkout root (main owns
 * that resolution — the exact board-read path), or null for a bare session.
 * Total: junk in → a typed refusal out, never a throw.
 */
export function serveBrainRead(
  host: BrainReadHost,
  verb: string,
  args: Record<string, unknown>,
  callerRoot: string | null
): BrainServeReply {
  try {
    const scope = resolveScope(host, args, callerRoot)
    if ('ok' in scope) return scope
    switch (verb) {
      case 'brain.status':
        return serveStatus(scope)
      case 'brain.query':
        return serveQuery(scope, args)
      case 'brain.node':
        return serveNode(scope, args)
      case 'brain.neighbors':
        return serveNeighbors(scope, args)
      case 'brain.path':
        return servePath(scope, args)
      case 'brain.symbol':
        return serveSymbol(scope, args)
      case 'brain.refs':
        return serveReferences(scope, args)
      case 'brain.map':
        return serveMap(scope, args)
      case 'brain.libraries':
        return serveLibraries(scope, args)
      case 'brain.libdocs':
        return serveLibDocs(scope, args)
      case 'brain.memSearch':
        return serveMemorySearch(scope, args)
      case 'brain.memGet':
        return serveMemoryGet(scope, args)
      case 'brain.memBacklinks':
        return serveMemoryBacklinks(scope, args)
      case 'brain.memSuggest':
        return serveMemorySuggest(scope, args)
      default:
        return refuse('invalid', `unknown brain verb: ${verb}`)
    }
  } catch (e) {
    // A read must never throw across the wire; `busy` is the store-trouble register.
    return refuse('busy', e instanceof Error ? e.message : String(e))
  }
}
