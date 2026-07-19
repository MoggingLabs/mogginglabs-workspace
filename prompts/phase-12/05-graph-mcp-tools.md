The Brain meets the agents: seven READ tools on the house MCP server,
free to every pane (ADR 0008's reads-free stance), scoped to the
caller's own checkout, every answer generation-stamped. The step where
sixteen agents start sharing one map.

## Steps
1. **The endpoint** (`brain/serve.ts` + the app endpoint the board
   reads use): register a `brain.*` read family on the existing relay
   — `bin/mogging-mcp.mjs` resolves the calling session's pane →
   workspace → projectKey + checkout root (the exact board-read
   path); a pane-less session (a human running the server bare) may
   pass an explicit `root` argument instead — reads are free either
   way; writes don't exist in this step.
2. **The tools** (schemas in the mcp bin, logic in `serve.ts`):
   `brain_status {}` → status + fidelity + cache stats;
   `query_graph { kind?, name?, file?, limit?, cursor? }` — glob on
   name/file, closed-union kind, paged (default 50, max 200);
   `get_node { id }` → node + file/lines/sig;
   `get_neighbors { id, direction: in|out|both, kinds?, limit? }`;
   `shortest_path { from, to, maxDepth = 8 }` — BFS, depth + visited
   caps (typed `too-deep` past them); `find_symbol { name, kind? }`
   — exact then glob, defs only; `find_references { id | name }` —
   resolved edges in, an honest note when `droppedRefs` is nonzero
   for the target's file. Every answer: `{ generation, dirty, root }`
   envelope; every response size-capped (64 KB — truncation flagged,
   the no-silent-caps rule). Junk → typed refusal, never a throw;
   unknown id → `unknown-node`, mirroring the board's unknown-card
   wording.
3. **Scope custody**: results filter to the CALLER'S root partition
   by default; `scope: 'project'` opts into cross-checkout reads
   (each hit then labeled with its root) — an agent may LOOK at a
   sibling worktree, never assume it is its own. No path outside the
   project's roots is readable through any brain tool.
4. **Registration honesty**: the tools appear in `tools/list` for
   every session (reads-free); the per-workspace TOOL PLANS matrix
   (phase-8) gains the brain family as a listed, default-on read
   group so the who-has-what surface stays truthful.
5. **BRAINMCP smoke** (`MOGGING_BRAINMCP`, dispatch branch,
   qa-smokes.sh row): drive `bin/mogging-mcp.mjs` as a REAL MCP
   client (stdio, the phase-8 precedent) against the 03 fixture —
   (a) every tool answers fixture-known truth; (b) pagination: page
   2 via cursor, no overlap, stable order; (c) shortest_path finds
   the known 3-hop chain; maxDepth 1 refuses `too-deep`; (d) a
   caller scoped to worktree A never sees B's partition without
   `scope: 'project'`; with it, every hit carries a root label;
   (e) stamps: mutate a file via shell, re-ask → generation advanced
   (freshness visible THROUGH the tool); (f) a 500-hit glob
   truncates with the flag set; (g) `tools/list` contains exactly
   the seven; zero brain write verbs anywhere in the listing.
   Verdict `out/brainmcp-result.json`.

## Files
- `brain/serve.ts` + query helpers · `bin/mogging-mcp.mjs` (brain
  read family) · tool-plan matrix data · `smokes/brainmcp-smoke.ts`
  · qa-smokes.sh row

## Definition of Done
- BRAINMCP green; the sweep count grows by one in the books.
- A real pane CLI answers "what defines X / what calls it" from the
  graph — verified once by hand (the manual-first rule).
- Existing MCP gates green unmodified (board reads, browser family).

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (incl. PROTOVER —
  the daemon socket carried nothing new); the five brain gates green
  in one isolation run.

## Guardrails
- READS ONLY — a write verb in this step is a review rejection.
- Every list capped + paged; every refusal typed; match the board
  family's error-wording register.
- Symbol names/paths stay out of telemetry (counts only, ADR 0005).
