Phase 2.5's promise, kept whole: `.memory/` — a wikilink knowledge
graph the TEAM owns. Plain markdown in the repo (git is the sync),
read free by every agent, written behind the grant, searched and
suggested deterministically (FTS5; link/term overlap — no LLM). The
Brain's human lens.

## Steps
1. **The format** (`brain/memory.ts`): files at
   `<projectRoot>/.memory/<slug>.md` — frontmatter `name` (the
   slug), `description`, optional `tags[]`; body markdown with
   `[[wikilinks]]` targeting other slugs. Slugs kebab-case,
   filename-safe, derived from `name` (hostile names sanitize;
   collisions refuse `exists`). A `[[link]]` to an unwritten slug
   is VALID — it marks wanted knowledge (dangling links are
   queryable). Plain files only: no db, index, or dotfile machinery
   inside `.memory/` — byte-portable, diff-reviewable.
2. **The index** (brain db tables `memories`, `memory_links` + FTS5
   `memories_fts(name, description, body)` — FTS5 ships in our
   from-source better-sqlite3): parsed on 03's walk (`.memory/`
   carved out of the walk-ignore so ONLY the memory indexer sees
   it; the code extractor still skips it), kept fresh by 04's
   routing. Backlinks derive from `memory_links` — never stored in
   the files.
3. **The tools**: reads join 05's family — `search_memories
   { query, limit? }` (FTS5 bm25 order — deterministic);
   `get_memory { slug }` (body + links + backlinks + dangling
   flags); `find_backlinks { slug }`; `suggest_connections
   { slug }` — deterministic score: shared links + shared tags +
   title-term overlap, fixed weights, fixed tiebreak; returns the
   scoring breakdown so the answer is auditable. Writes join 07's
   granted family with 07's guards: `create_memory { name,
   description, body, tags? }`, `update_memory { slug,
   expectedFileHash, body }` (same stale/atomic discipline;
   `.memory/` of the caller's checkout only). Trail: counts only.
4. **Project custody**: memories live per checkout but READ
   project-wide — the freshest indexed copy across roots wins,
   root-labeled; writes land in the CALLER'S checkout and git merges
   them home. Recorded in ADR 0018 as the memory-flow stance.
5. **MEMGRAPH smoke** (`MOGGING_MEMGRAPH`, dispatch branch,
   qa-smokes.sh row): real MCP client, granted fixture — (a) create
   → file exists with exact frontmatter, slug kebab-cased from a
   hostile name (`"; rm -rf / [[x]]"` → sanitized, inert);
   (b) `[[wikilinks]]` across three memories → backlinks exact; a
   dangling link reported dangling; (c) FTS finds a body term,
   ranked order stable across two runs; (d) suggest_connections
   returns the fixture-known neighbor first WITH its breakdown;
   (e) update with stale hash refuses, disk untouched; (f) edit a
   memory via a real shell pane → 04's drain reindexes within a
   tick (the backlink appears); (g) no grant → creates refuse,
   reads still answer; (h) delete the brain db, rebuild → search
   restored (files are the truth); (i) `.memory/` contains ONLY
   `.md` files after the whole run. Verdict
   `out/memgraph-result.json`.

## Files
- `brain/memory.ts` + schema rows + FTS5 migration · walk
  carve-out · `serve.ts` + `bin/mogging-mcp.mjs` (4 reads, 2
  granted writes) · `smokes/memgraph-smoke.ts` · qa-smokes.sh row

## Definition of Done
- MEMGRAPH green; the sweep count grows by one.
- A memory written in worktree A is found by search from B after a
  merge — proven in the smoke with real git.
- BRAINWRITE and the walk gates green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; the nine brain
  gates green in isolation.

## Guardrails
- Files are the truth; the index is disposable.
- Deterministic search + suggestions — an unexplainable ranking is
  a bug.
- Memory text never in telemetry; trail carries counts only.
- No write outside `.memory/` of the caller's checkout, ever.
