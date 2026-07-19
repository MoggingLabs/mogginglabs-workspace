import {
  MEMORY_RECALL_DEFAULT_LIMIT,
  MEMORY_RECALL_MAX_LIMIT
} from '@contracts'
import { blobToVector, cosineSim } from './embed'
import { MEMORY_HYBRID_RRF_K, MEMORY_HYBRID_WEIGHTS } from './memory'
import {
  capReply,
  envelope,
  freshestBySlug,
  intArg,
  parseTags,
  refuse,
  resolveScope,
  str,
  type BrainReadHost,
  type BrainServeReply,
  type MemorySemanticLens,
  type ResolvedScope
} from './serve'

// The RECALL organ (ADR 0018 revision D): rank CURATED memories against a
// TASK'S text — the read a cold pane is pre-briefed with (06's injection door)
// and a working agent asks "what do we know about this?" through. Project-wide
// by the memory-read law (freshest copy wins, root-labeled), and DETERMINISTIC
// BY DEFAULT: the base score is FTS5 bm25 (OR over the task's terms — a task
// is prose, not a conjunction) plus fixed-weight tag-match and backlink-count
// boosts, with the full breakdown served per hit so the arithmetic is
// auditable (ADR 0018.i: an unexplainable ranking is a bug). The semantic
// lens's consent upgrades the blend to HYBRID — revision A's fixed-weight RRF
// of the base list and the cosine list, every hit labeled probabilistic with
// its provider and model (the lens law, verbatim). Drafts never appear in any
// mode: this module reads only the curated tables (quarantine as topology,
// revision C). Every answer rides an ordinary recall bump into memory_usage —
// the usage truth the HUMAN prunes by; the app never decays or deletes.

/** Fixed recall weights — served back inside every breakdown. `fts` scales the
 *  bm25 goodness (SQLite's rank negated); `tag` and `backlink` are per-count
 *  points, the backlink boost capped so popularity seasons relevance and never
 *  replaces it. */
export const MEMORY_RECALL_WEIGHTS = { fts: 1, tag: 2, backlink: 1 } as const
export const MEMORY_RECALL_BACKLINK_CAP = 3
/** Raw FTS rows fetched before the freshest-copy dedupe — a hard read cap. */
const MEMORY_RECALL_FETCH_CAP = 400
/** Task terms considered, after which the rest of the prose says nothing new. */
const MEMORY_RECALL_MAX_TERMS = 24

/** FTS5 MATCH expression for a TASK: bare terms, each quoted (junk cannot
 *  crash the parser), joined by OR — a memory matching ANY term is a
 *  candidate, and bm25 ranks how well. Null when nothing is searchable. */
export function memoryRecallExpr(task: string): string | null {
  const tokens = task.match(/[A-Za-z0-9_]+/g)
  if (!tokens || !tokens.length) return null
  return [...new Set(tokens.map((t) => t.toLowerCase()))]
    .slice(0, MEMORY_RECALL_MAX_TERMS)
    .map((t) => `"${t}"`)
    .join(' OR ')
}

/** Lowercased word tokens of the task — the tag-match half's material. */
export const recallTaskTerms = (task: string): Set<string> =>
  new Set(task.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) ?? [])

interface RecallCandidate {
  slug: string
  name: string
  description: string
  tags: string[]
  root: string
  score: number
  breakdown: Record<string, unknown>
}

/** The deterministic base ranking — every candidate scored, order fixed
 *  (score desc, slug asc). Exported for the hybrid blend and the smoke. */
function rankCandidates(s: ResolvedScope, task: string, expr: string): RecallCandidate[] {
  const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
  // The FTS list: the exact-search law verbatim — among the copies that
  // matched, the freshest wins and keeps its own bm25 rank.
  const ftsKept = [...freshestBySlug(s.store.memorySearch(s.projectRoots, expr, MEMORY_RECALL_FETCH_CAP), s.projectRoots).values()]
  const bm25BySlug = new Map(ftsKept.map((h) => [h.slug, h.rank]))
  // Backlink counts: distinct LINKING slugs per target, project-wide — the
  // same derivation find_backlinks serves.
  const backlinkCount = new Map<string, number>()
  const linkers = new Map<string, Set<string>>()
  for (const l of s.store.memoryLinks(s.projectRoots)) {
    const set = linkers.get(l.dst) ?? new Set<string>()
    set.add(l.src)
    linkers.set(l.dst, set)
  }
  for (const [dst, set] of linkers) backlinkCount.set(dst, set.size)

  const terms = recallTaskTerms(task)
  const out: RecallCandidate[] = []
  for (const [slug, row] of written) {
    const tags = parseTags(row.tags)
    const matchedTags = tags.filter((t) => terms.has(t)).sort()
    const bm25 = bm25BySlug.get(slug)
    // A candidate matched the task's text OR one of its tags — the backlink
    // boost seasons candidates, it never mints one (popularity is not recall).
    if (bm25 === undefined && !matchedTags.length) continue
    const backlinks = backlinkCount.get(slug) ?? 0
    const ftsComponent = bm25 === undefined ? 0 : MEMORY_RECALL_WEIGHTS.fts * Math.max(0, -bm25)
    const tagComponent = MEMORY_RECALL_WEIGHTS.tag * matchedTags.length
    const backlinkComponent = MEMORY_RECALL_WEIGHTS.backlink * Math.min(backlinks, MEMORY_RECALL_BACKLINK_CAP)
    out.push({
      slug,
      name: row.name,
      description: row.description,
      tags,
      root: row.root,
      score: ftsComponent + tagComponent + backlinkComponent,
      // The breakdown IS the audit: the three components SUM to the score.
      breakdown: {
        bm25: bm25 ?? null,
        ftsComponent,
        matchedTags,
        tagComponent,
        backlinks,
        backlinkComponent,
        weights: MEMORY_RECALL_WEIGHTS,
        backlinkCap: MEMORY_RECALL_BACKLINK_CAP
      }
    })
  }
  out.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  return out
}

const hitOut = (c: RecallCandidate): Record<string, unknown> => ({
  slug: c.slug,
  name: c.name,
  description: c.description,
  tags: c.tags,
  root: c.root,
  score: c.score,
  breakdown: c.breakdown
})

/**
 * The one recall dispatch. `lens` is null for the deterministic world (no
 * consent, no config, or an embed that failed — the caller labels the truth by
 * simply not passing one); non-null upgrades the blend to hybrid under the
 * lens law. Total: junk in → a typed refusal out, never a throw.
 */
export function serveBrainRecall(
  host: BrainReadHost,
  args: Record<string, unknown>,
  callerRoot: string | null,
  lens: MemorySemanticLens | null
): BrainServeReply {
  try {
    const s0 = resolveScope(host, args, callerRoot)
    if ('ok' in s0) return s0
    const s = s0
    const task = str(args.task)
    if (!task) return refuse('invalid', 'task is required — the text to recall against')
    const limit = intArg(args.limit, MEMORY_RECALL_DEFAULT_LIMIT, 1, MEMORY_RECALL_MAX_LIMIT)
    if (limit === null) return refuse('invalid', `limit must be 1-${MEMORY_RECALL_MAX_LIMIT}`)
    const written = freshestBySlug(s.store.memoriesForRoots(s.projectRoots), s.projectRoots)
    if (!written.size) {
      return refuse(
        'no-brain',
        'this project has no team memories indexed yet — write one (create_memory), or rebuild the brain if .memory/ files exist'
      )
    }
    const expr = memoryRecallExpr(task)
    if (!expr) return refuse('invalid', 'the task has no searchable terms')
    const base = rankCandidates(s, task, expr)

    if (!lens) {
      const reply = capReply(
        { ok: true, ...envelope(s), mode: 'exact', memories: base.slice(0, limit).map(hitOut), truncated: base.length > limit },
        'memories'
      )
      bumpRecalls(s, reply.memories as { slug: string }[])
      return reply
    }

    // Hybrid (revision A's blend, on the recall lists): fixed-weight
    // reciprocal-rank fusion of the BASE list and the cosine list — the two
    // components SUM to the score, and every hit wears the lens law's label.
    const vectors = new Map<string, Float32Array>()
    for (const row of s.store.memoryVectorRows(lens.model)) {
      if (!written.has(row.slug)) continue
      const vec = blobToVector(row.vec, row.dim)
      if (vec) vectors.set(row.slug, vec)
    }
    const unembedded = written.size - vectors.size
    const semRanked = [...vectors.entries()]
      .map(([slug, vec]) => ({ slug, score: cosineSim(lens.queryVec, vec) }))
      .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    const baseBySlug = new Map(base.map((c) => [c.slug, c]))
    const baseRank = new Map(base.map((c, i) => [c.slug, i + 1]))
    const semRank = new Map(semRanked.map((r, i) => [r.slug, i + 1]))
    const blended = [...new Set([...baseRank.keys(), ...semRank.keys()])]
      .map((slug) => {
        const b = baseRank.get(slug)
        const v = semRank.get(slug)
        const baseComponent = b === undefined ? 0 : MEMORY_HYBRID_WEIGHTS.fts / (MEMORY_HYBRID_RRF_K + b)
        const semComponent = v === undefined ? 0 : MEMORY_HYBRID_WEIGHTS.semantic / (MEMORY_HYBRID_RRF_K + v)
        return { slug, score: baseComponent + semComponent, baseComponent, semComponent, b: b ?? null, v: v ?? null }
      })
      .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    const page = blended.slice(0, limit)
    const rows = page.map((r) => {
      const c = baseBySlug.get(r.slug)
      const m = written.get(r.slug) as { name: string; description: string; tags: string; root: string }
      return {
        slug: r.slug,
        name: c?.name ?? m.name,
        description: c?.description ?? m.description,
        tags: c?.tags ?? parseTags(m.tags),
        root: c?.root ?? m.root,
        // The lens law's label, load-bearing: this order is an OPINION, and it
        // says whose.
        probabilistic: true,
        provider: lens.provider,
        model: lens.model,
        score: r.score,
        breakdown: {
          baseRank: r.b,
          semRank: r.v,
          baseComponent: r.baseComponent,
          semComponent: r.semComponent,
          weights: MEMORY_HYBRID_WEIGHTS,
          k: MEMORY_HYBRID_RRF_K,
          // The deterministic half's own audit rides along when it exists.
          base: c?.breakdown ?? null
        }
      }
    })
    const reply = capReply(
      {
        ok: true,
        ...envelope(s),
        mode: 'hybrid',
        memories: rows,
        truncated: blended.length > limit,
        ...(unembedded > 0 ? { unembedded } : {})
      },
      'memories'
    )
    bumpRecalls(s, reply.memories as { slug: string }[])
    return reply
  } catch (e) {
    return refuse('busy', e instanceof Error ? e.message : String(e))
  }
}

/** Every slug a recall ANSWER carries earns one usage count (revision D) — the
 *  tool, the CLI, and the spawn injection all land here. A locked store loses
 *  one bump; honesty accounting never blocks an answer. */
function bumpRecalls(s: ResolvedScope, page: { slug: string }[]): void {
  for (const hit of page) {
    try {
      s.store.bumpMemoryUsage(hit.slug, 'recall')
    } catch {
      /* counted next time */
    }
  }
}
