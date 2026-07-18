// The repomap's RENDER (ADR 0018, step 06): the ranked graph as a budgeted text
// map a cold agent reads in seconds. Files ordered by their best-ranked symbol,
// each as `path:` over indented SIGNATURE lines (nodes.sig — never a file body,
// by law), greedily filled into a CHARACTER budget: characters, not tokens,
// because characters are deterministic and CLI-neutral. WHOLE lines only —
// a mid-line cut is a lie about the code. Ties break (rank desc, path asc,
// line asc), fixed forever: two renders of one generation are byte-identical.
// The last line is the honesty stamp: `[repomap: generation N, X/Y files]` —
// what you see, out of what exists, as of which index.

export const REPOMAP_DEFAULT_BUDGET = 4000
export const REPOMAP_MAX_BUDGET = 16000
export const REPOMAP_MIN_BUDGET = 200

export interface RepoMapNodeRow {
  file: string
  startLine: number
  sig: string
  rank: number
}

export function renderRepoMap(
  rows: readonly RepoMapNodeRow[],
  opts: { budget: number; generation: number; totalFiles: number }
): string {
  const budget = Math.max(REPOMAP_MIN_BUDGET, Math.min(REPOMAP_MAX_BUDGET, Math.floor(opts.budget)))
  // Group signature-bearing nodes by file (module rows carry no sig — skipped).
  const byFile = new Map<string, RepoMapNodeRow[]>()
  for (const row of rows) {
    if (!row.sig.trim()) continue
    const list = byFile.get(row.file) ?? []
    list.push(row)
    byFile.set(row.file, list)
  }
  const files = [...byFile.entries()].map(([file, nodes]) => ({
    file,
    best: nodes.reduce((m, r) => (r.rank > m ? r.rank : m), 0),
    nodes: nodes.sort((a, b) => a.startLine - b.startLine || b.rank - a.rank || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
  }))
  files.sort((a, b) => b.best - a.best || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  // Reserve the WIDEST the stamp can be (X ≤ Y never widens it), so the stamp
  // always fits and the budget still binds the whole output.
  const stampWidth = `[repomap: generation ${opts.generation}, ${opts.totalFiles}/${opts.totalFiles} files]`.length
  const room = budget - stampWidth - 1 // the newline joining body to stamp

  const lines: string[] = []
  let used = 0
  let filesShown = 0
  for (const f of files) {
    const header = `${f.file}:`
    const first = `  ${f.nodes[0].sig}`
    const headerCost = header.length + 1 + first.length + 1
    if (used + headerCost > room) continue // whole files start whole, or not at all
    lines.push(header, first)
    used += headerCost
    filesShown += 1
    for (let i = 1; i < f.nodes.length; i++) {
      const line = `  ${f.nodes[i].sig}`
      if (used + line.length + 1 > room) break // whole lines only, never a mid-line cut
      lines.push(line)
      used += line.length + 1
    }
  }
  const stamp = `[repomap: generation ${opts.generation}, ${filesShown}/${opts.totalFiles} files]`
  return lines.length ? `${lines.join('\n')}\n${stamp}` : stamp
}
