import * as path from 'node:path'
import type { BrainRefusal, BrainStatus } from '@contracts'
import { foldProjectKey } from '../workspace/project-identity'
import { BRAIN_EDGE_KINDS, BRAIN_NODE_KINDS, type BrainNodeRow } from './schema'
import type { BrainStore } from './store'

// The brain MEETS the agents (ADR 0018, step 05): seven READ verbs behind the
// `brain.*` family on the house MCP server — free to every pane (ADR 0008's
// reads-free stance), scoped to the CALLER'S own checkout partition unless
// `scope: 'project'` opts into labeled cross-checkout reads. Every answer wears
// the `{ generation, dirty, root }` envelope (staleness visible THROUGH the
// tool), every list is capped and paged, every response is size-capped with the
// truncation FLAGGED (the no-silent-caps rule), and junk is a typed refusal in
// the board family's wording register — never a throw. WRITES DO NOT EXIST
// HERE: the catalog validator structurally rejects a brain verb that is not a
// read, and this module exposes nothing that mutates.
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

interface NodeOut {
  id: string
  kind: string
  name: string
  file: string
  startLine: number
  endLine: number
  sig: string
  root?: string
}

const nodeOut = (row: BrainNodeRow, labelRoot: boolean): NodeOut => ({
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
 *  identity uses everywhere. */
function partitionOf(roots: string[], base: string): string | null {
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
  return { ok: true, ...envelope(s), node: nodeOut(row, s.labeled) }
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
      default:
        return refuse('invalid', `unknown brain verb: ${verb}`)
    }
  } catch (e) {
    // A read must never throw across the wire; `busy` is the store-trouble register.
    return refuse('busy', e instanceof Error ? e.message : String(e))
  }
}
