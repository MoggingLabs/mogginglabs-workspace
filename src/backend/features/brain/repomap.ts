import type { BrainEdgeRow, BrainNodeRow, BrainRankRow } from './schema'

// The repomap's RANK (ADR 0018, step 06): PageRank over the symbol graph we
// already hold — the algorithm SHAPE popularized by Aider's repomap, written
// clean-room against the house rows. references, imports, and heritage edges
// all weigh in (a mention is stronger evidence of importance than plumbing);
// the personalization vector carries the core insight: a symbol referenced
// from MANY DISTINCT FILES matters more than one referenced many times from
// one file.
//
// DETERMINISTIC BY LAW, not by luck: damping 0.85, a FIXED 30 iterations (no
// epsilon early-exit — convergence checks are float-order-sensitive), and every
// accumulation runs in sorted-id order so the float additions happen in ONE
// order forever. Same rows in, same ranks out, byte for byte — a flaky map is
// a broken map. Runs in the indexer worker at commit time; the ranks land in
// the SAME transaction as the partition they describe, so a stale rank is
// impossible by construction.

const DAMPING = 0.85
const ITERATIONS = 30

/** How hard each edge kind pulls rank toward its target. A reference is the
 *  loudest signal; imports/heritage are structure; defines is faint plumbing
 *  (it lets a file's weight reach the symbols it defines, nothing more). */
const EDGE_WEIGHT: Record<string, number> = {
  references: 1,
  imports: 0.5,
  extends: 0.5,
  implements: 0.5,
  defines: 0.1
}

/**
 * Rank one partition's nodes. Pure: rows in, ranks out (unnormalized relative
 * importance — only the ORDER and ratios matter to the renderer).
 */
export function computeRepoRanks(
  nodes: readonly Pick<BrainNodeRow, 'id' | 'file'>[],
  edges: readonly Pick<BrainEdgeRow, 'src' | 'dst' | 'kind'>[]
): BrainRankRow[] {
  const ids = nodes.map((n) => n.id).sort()
  const index = new Map<string, number>()
  for (let i = 0; i < ids.length; i++) index.set(ids[i], i)
  const n = ids.length
  if (n === 0) return []
  const fileOf = new Map<string, string>()
  for (const node of nodes) fileOf.set(node.id, node.file)

  // Weighted adjacency in FIXED order: edges sorted by (src, dst, kind).
  const sorted = [...edges].sort((a, b) =>
    a.src < b.src ? -1 : a.src > b.src ? 1 : a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
  )
  const outWeight = new Array<number>(n).fill(0)
  const links: { from: number; to: number; w: number }[] = []
  // The personalization ingredient: distinct REFERRER FILES per target.
  const referrerFiles = new Map<number, Set<string>>()
  for (const e of sorted) {
    const from = index.get(e.src)
    const to = index.get(e.dst)
    const w = EDGE_WEIGHT[e.kind] ?? 0
    if (from === undefined || to === undefined || w === 0 || from === to) continue
    links.push({ from, to, w })
    outWeight[from] += w
    if (e.kind === 'references') {
      const file = fileOf.get(e.src) ?? ''
      const set = referrerFiles.get(to) ?? new Set<string>()
      set.add(file)
      referrerFiles.set(to, set)
    }
  }

  // Personalization: everyone starts audible; broad reach amplifies log-scale.
  const pers = new Array<number>(n).fill(0)
  let persSum = 0
  for (let i = 0; i < n; i++) {
    pers[i] = 1 + Math.log(1 + (referrerFiles.get(i)?.size ?? 0)) * 4
    persSum += pers[i]
  }
  for (let i = 0; i < n; i++) pers[i] /= persSum

  let rank: number[] = [...pers]
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Array<number>(n).fill(0)
    // Dangling mass (nodes with no outgoing weight) flows via personalization.
    let dangling = 0
    for (let i = 0; i < n; i++) if (outWeight[i] === 0) dangling += rank[i]
    for (const l of links) next[l.to] += (rank[l.from] * l.w) / outWeight[l.from]
    for (let i = 0; i < n; i++) {
      next[i] = (1 - DAMPING) * pers[i] + DAMPING * (next[i] + dangling * pers[i])
    }
    rank = next
  }

  return ids.map((id, i) => ({ id, rank: rank[i] }))
}
