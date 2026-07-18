# ADR 0018 — The workspace brain: one graph, many readers

- **Status:** Accepted (2026-07-18). Step 02 of the brain plan ships the LAWS below —
  identity, lifecycle, status, typed refusals (`BrainService`, `brain:*`, the BRAINCORE
  gate) — before any graph exists, so every later step inherits them instead of
  retrofitting them.
- **Relates to:** ADR 0004 (layering: contracts / backend / main), ADR 0005 (what may
  reach telemetry), ADR 0008 §b (protocols, not plugins — nothing new listens),
  docs/[02-mvp-and-roadmap.md](../02-mvp-and-roadmap.md) §Phase 12 (the roadmap entry
  this begins), docs/research/[2026-07-vibe-coding-ecosystem.md](../research/2026-07-vibe-coding-ecosystem.md)
  (the research this synthesizes).

## Context

Sixteen agents in one workspace re-scan one tree sixteen times. Each pane burns its
first ~20k tokens rediscovering the repo the pane beside it just mapped, then goes
stale about it independently. The product's whole premise — many agents, one project —
creates the need for **one shared map**: a per-project index every pane can read, kept
honest about its own freshness, owned by the app rather than by any single pane.

This ADR fixes the brain's laws before its features, because every one of them is the
kind of decision that is cheap now and expensive to walk back: where the index lives,
who it belongs to, what it may claim, and what it refuses.

## Decision — the stances

**(a) Determinism — an index, not an oracle.** No LLM, no embeddings, no vector store,
no cloud, no account. Every answer is reproducible from bytes on disk: the same tree
always yields the same graph, the same query the same rows. This is the only kind of
index that fits a local-first app with a free tier and a no-account promise — and the
only kind whose answers a gate can assert. Ranking, when it lands, is deterministic
arithmetic (the repomap lineage below), never a model's opinion. Projects that cannot
be indexed affordably are refused honestly: the caps are contracts
(`BRAIN_MAX_FILES = 50_000`, `BRAIN_MAX_FILE_BYTES = 1_048_576`), and exceeding them
answers `too-large` — never a half-index in silence.

**(b) Derived state.** The index lives in the app data dir —
`<userData>/brain/<projectKey>.db`, the key hashed into a filename (a project key is an
absolute path; the hash is over the case-folded key, so two Windows spellings of one
folder are one db). It is deletable and rebuildable at any moment, and it is **never in
the repo**: nothing of ours lands in the user's tree, no `.brain/` to gitignore, no
index to accidentally commit, no worktree carrying a second copy.

**(c) Per-PROJECT identity — the board-v2 rule.** A linked worktree shares its parent
repo's brain; a plain folder gets folder identity. Sixteen worktrees of one repo are
one project, one graph, one db — which is the entire point of a shared map. The
resolver is the board's own, **extracted** to
`@backend/features/workspace/project-identity.ts` (not forked): two resolvers would
eventually give one directory two identities, and then a worktree's brain and its board
would disagree about which project they belong to.

**(d) Freshness is a law.** Every answer stamps `{ generation, dirty }`. Staleness is
surfaced, never silent: an agent acting on an old map must be able to know it is old,
because a confidently stale answer is worse than no answer. Step 04 owns raising
`dirty`; this step makes the stamp structural so no later reader can be built without
it.

**(e) Custody.** Reads are free to every pane — the brain exists to be read. ALL disk
mutation over MCP rides the per-workspace grant (the 8/03 write wall, as 07/09 will
bind it): the brain adds no second path around the grant, and no read verb ever
mutates.

**(f) Daemon untouched.** The brain is an app service plus (from 03) a
`worker_threads` indexer, reached over the EXISTING endpoint relay
(`bin/mogging-mcp.mjs`). Nothing new listens — no port, no socket, no server (ADR
0008 §b). The PTY daemon's job is terminal survival (ADR 0006); it does not grow an
index, and the brain does not grow a process.

**(g) WASM-only parsers.** Parsing is `web-tree-sitter` — WASM grammars, one artifact
per language, identical bytes on every OS. Native tree-sitter is **refused**: it would
add a third ABI-bound native to the two we already carry (node-pty, better-sqlite3),
each of which has cost real regressions across the Electron/helper ABI split (ADR
0017) — and a parser fleet is the worst possible candidate, being per-language ×
per-platform × per-ABI. WASM trades peak parse speed for zero rebuild surface, and an
indexer that runs off the UI thread can afford it. The grammars are **vendored,
hash-pinned data** (`src/backend/features/brain/grammars.json` + committed artifacts
under `assets/grammars/`): installs stay offline and deterministic; upstream drift
arrives only through the operator-run update script and fails the offline GRAMMARCAT
gate otherwise. Adding a language is a catalog row + an artifact + a tag query — zero
code. **Grammar roster (gated):** `bash c c_sharp cpp css go html java javascript
json php python ruby rust toml tsx typescript yaml` — this line is parsed by
`scripts/check-grammar-catalog.mjs` and must equal the catalog exactly.

**(h) Privacy (ADR 0005).** Paths, symbols, and memory text never reach telemetry.
Refusal reasons are a closed enum; counts and booleans may be measured, content may
not. The `detail` field on a refusal exists for the UI and the smokes, and stays
local.

## The shipped shape (this step)

- **Contracts** (`src/contracts/ipc/brain.ipc.ts`, `BrainChannels`): `brain:status` and
  `brain:rebuild` — `({ root }) -> BrainStatus | BrainRefusal` — and the
  `brain:changed` push `({ projectKey, generation, dirty })`. Closed unions, no `any`;
  refusals are `missing | invalid | too-large | busy`.
- **Backend** (`src/backend/features/brain/`, Electron-free): `project.ts` (identity +
  sibling worktree roots, via the extracted resolver), `store.ts` (better-sqlite3, WAL,
  schema = `meta(schema_version, generation)` **alone** — 03 owns the graph),
  `index.ts` (`BrainService`: lazy per-project instances, LRU-capped at 4 open dbs,
  `status()`, `rebuild()`, `dispose()`).
- **Main** (`src/main/brain.ts`): `registerBrain()` binds the verbs, validates shape
  (junk → `invalid`, never a throw), derives the db dir from the userData layout, and
  pushes `brain:changed` on accepted rebuilds.
- **No UI, no parser, no walker, no watcher.** A rebuild in a graph-less brain is pure
  lifecycle: the generation moves, and the (empty) derived state is by definition
  rebuilt.

## Proven by

- **BRAINCORE** (`MOGGING_BRAINCORE`, windowless, verdict `out/braincore-result.json`):
  on a fixture repo + real linked worktree + plain folder — repo and worktree resolve
  to the SAME projectKey and the folder to its own; status answers zeroed counts and a
  real generation; the db sits under userData and never under a root; `missing` and
  `invalid` refuse as typed values; rebuild bumps the generation visibly from the
  worktree root (one project, one brain); dispose closes handles (the db file deletes
  cleanly on Windows); a deleted db rebuilds from scratch; the LRU caps open handles.
- **BOARDV2** unmodified green — the identity extraction changed the board's bytes'
  home, not their behavior. **CHANNELS** holds the preload allowlist; **PROTOVER**
  holds the daemon wire untouched.

## Deferrals (named, not implied)

- **LSP-grade resolution.** tree-sitter gives syntax, not semantics: no type-directed
  call resolution, no cross-file inference. The graph's edges will be honest about
  being syntactic. If LSP truth ever lands it is a separate ADR — it drags servers,
  versions, and per-language daemons with it.
- **Cross-project graphs.** One brain per project, by law (c). Monorepo sub-projects
  share one brain via the repo root; two repos never share anything.
- **Rename-symbol** (and symbol-level writes generally): the write wall (e) makes the
  custody answer, but the feature itself is deferred until the graph can support it —
  a rename over a syntactic graph is a find-and-pray, and we don't ship those.

## Research lineage

The brain synthesizes four clean-room shapes surveyed in
docs/research/[2026-07-vibe-coding-ecosystem.md](../research/2026-07-vibe-coding-ecosystem.md)
(capability #1) and committed on the roadmap as Phase 12
(docs/[02-mvp-and-roadmap.md](../02-mvp-and-roadmap.md)): **Graphify** (MIT) is the
deterministic tree-sitter code graph — no LLM, no embeddings — that stance (a) adopts
as the only index shape fitting a free, local-first, no-account app; **Serena** (MIT)
is the symbol-level write surface whose custody question stance (e) answers now and
whose feature the deferrals hold until the graph earns it; **Context7** (MIT) is the
version-correct third-party-docs lens — the one thing a local graph cannot know — kept
out of scope here precisely because it needs network and the brain's core must not;
and **Aider's repomap** (Apache-2.0) is the deterministic ranked-injection algorithm
(tree-sitter + PageRank) that stance (a)'s "ranking is arithmetic" line reserves room
for. Read, never linked: the loudest projects in this space are AGPL/GPL and stay out
of the tree (docs/02 §risk 5).
