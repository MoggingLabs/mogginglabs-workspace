# 20 — The Workspace Brain: one graph, many readers

Sixteen agents in one workspace re-scan one tree sixteen times. Each pane burns
its first ~20k tokens rediscovering the repo the pane beside it just mapped,
then goes stale about it independently. The Brain is the answer the product's
own premise demands: **one context service per project**, mounted into every
pane over the house MCP server, holding a deterministic tree-sitter code graph,
a ranked repomap injected at spawn, symbol-level writes behind the grant,
version-correct library docs, the team's `.memory/` wikilink graph — and the
full memory arc: auto-captured drafts, granted promotion, and recall at spawn.

> **The two laws, up front.** The Brain is an **index, not an oracle**
> ([ADR 0018](adr/0018-workspace-brain.md) stance a): no LLM, no embeddings, no
> vector store, no cloud, no account in the core — every answer reproducible
> from bytes on disk, every ranking deterministic arithmetic. And over that
> core, **probabilistic lenses exist only under the lens law**
> (ADR 0018 revision A): opt-in per workspace, on the **user's own** BYO
> provider, every fuzzy hit labeled `probabilistic: true` with the provider and
> model that scored it — and **never the truth layer**: the offline core and
> every deterministic tool answer byte-identically with the lens on, off, or
> broken.

Lineage (each shape taken for its best organ, sourced in
`prompts/phase-12/RESEARCH.md` and
[docs/research/2026-07-vibe-coding-ecosystem.md](research/2026-07-vibe-coding-ecosystem.md)):
Graphify's deterministic local graph (MIT), Serena's symbol-level operations
(MIT), Aider's repomap algorithm (tree-sitter + PageRank, clean-room),
Context7's version-correct docs (shape only — ours is local-first), Obsidian's
wikilink + properties conventions (format, not code), and cipher/ByteRover's
memory capture + semantic recall (Elastic-2.0 — a code wall; shape only,
clean-room).

---

## 1. Architecture: service + worker + db

The Brain lives **in the app** — the PTY daemon is untouched (its protocol
number is unchanged; `PROTOVER` keeps proving it), and nothing new listens
(ADR 0008 §b: protocols, not plugins).

```
src/backend/features/brain/   the engine (Electron-free, unit-testable)
src/main/brain.ts             app wiring: paths, validation, IPC, consents
out/main/brain-worker.js      the worker_threads indexer (built artifact)
<userData>/brain/<hash>.db    one SQLite db per PROJECT (better-sqlite3, WAL)
bin/mogging-mcp.mjs           the EXISTING endpoint relay every pane already has
```

- **`BrainService`** (`brain/index.ts`) holds lazy per-project instances,
  LRU-capped at **4 open dbs**; `dispose()` is a lifecycle law (the freshness
  smoke tears it down cold and the first status after reopen heals by
  reconcile, not a full reparse).
- **The indexer is a `worker_threads` worker** — parsing never shares the UI
  thread. A full build is ONE transactional commit; an incremental drain lands
  the delta the same way. Cross-worktree economics ride the
  **content-addressed parse cache**: identical bytes parse once, and the
  hit/miss counts are stored in `meta` and served (the Brain view's "Parse
  cache" row; BRAINMILESTONE asserts ≥ 90% hits on a sibling worktree).
- **Parsers are WASM** (`web-tree-sitter`) — zero native-ABI churn on Electron
  bumps, by construction (stance g). The grammars are **vendored, hash-pinned
  data**: `brain/grammars.json` + committed artifacts under `assets/grammars/`.
  Roster: `bash c c_sharp cpp css go html java javascript json php python ruby
  rust toml tsx typescript yaml`.

**Per-PROJECT identity — the board-v2 rule.** A linked worktree shares its
parent repo's brain; a plain folder gets folder identity. The resolver is the
board's own, **extracted** (not forked) to
`@backend/features/workspace/project-identity.ts`, so a worktree's brain and
its board can never disagree about which project they belong to
([docs/18-board.md](18-board.md)). Inside the one db, every checkout root is
its own **partition**: a pane reads its own checkout by default; `scope:
'project'` widens to the labeled sibling worktrees, and every widened hit
carries its `root`.

**Derived state** (stance b): the db is deletable and rebuildable at any
moment, and it is never in the repo — no `.brain/` to gitignore, no index to
accidentally commit. The one deliberate exception is `.memory/` (§6): those are
the **user's** bytes, git-carried; the db's memory tables are a disposable
shadow rebuilt from one scan.

**The endpoint relay.** Panes reach the Brain through the same
`bin/mogging-mcp.mjs` stdio server Phase 8 shipped
([docs/14-integrations.md](14-integrations.md)) — the bin talks to the app over
the private app endpoint; the app answers from the service. A paneless session
(a bare human shell, the CLI verbs) must name a `root`; a pane session is
scoped to its own checkout automatically.

---

## 2. How it stays current — the freshness law's three organs

Freshness is a law, not a feature (stance d): **every answer stamps
`{ generation, dirty }`**, so staleness is visible, never silent. Three
knowledge sources, three organs, each riding machinery the app already paid
for:

**Organ 1 — the workspace repo: the git tick.** The Brain subscribes to the
EXISTING 2.5s GitMonitor porcelain tick (the phase-11 move: parse what we
already pay for — zero new pollers, zero new watchers). Changed files raise
`dirty` immediately; a debounced **drain** re-indexes just the delta off the
exclusive queue, lands it transactionally, bumps the generation by one, and
pushes ONE `brain:changed`. Head moves (commit, branch switch) are
**delta-only**: a `git diff` between the two heads names the files; a commit
that changes no worktree byte drains nothing; a branch round-trip reparses
exactly the changed files and returns the dump byte-identical. Non-repo roots
get the same cadence from a capped mtime sweep. Cold starts heal by
**reconcile**: the first status after reopen compares disk to db incrementally
— `BRAINFRESH` proves an agent's write is queryable within **≤ 2 ticks** and
that `dirty` settles to 0, polled, never slept.

**Organ 2 — third-party libraries: lockfile re-resolve.** Versions come from
**lockfiles** (exact, deterministic, offline — npm v3, `requirements.txt`);
docs come from the **installed packages on disk** (README + bundled `.d.ts`
distilled to signatures; Python docstrings + dist-info). A lockfile change
re-resolves on the same git tick: new version served, `installed:false` when
the disk lags, and the old version's cached doc rows **pruned** (the reference
law — a cache row exists only while a lockfile pins it). The opt-in
registry-fetch path is per-workspace consent, default OFF, checked before any
socket exists.

**Organ 3 — upstream grammar releases: the catalog script pair.** Grammar
drift arrives only through the operator: `npm run catalog:grammars:update`
rewrites the hash-pinned catalog; `scripts/check-grammar-catalog.mjs` (the
**GRAMMARCAT** static gate) fails the sweep if the committed catalog, the
vendored artifacts, and the ADR's gated roster line disagree. Upstream drift is
a red gate, not a surprise — the agent-settings-catalog precedent.

---

## 3. The tool table

Every verb rides the house MCP server; the sets are **closed by the catalog
validator** — growing any of them is an ADR revision, not a code change. Reads
are free to every pane (ADR 0008); writes sit behind the per-workspace grant
(§5). Junk input refuses typed, never throws; refusal reasons are a closed
enum (`missing · invalid · too-large · busy · forbidden · stale · exists ·
consent · embed-failed`), and every reply carries `{ generation, dirty }`.

| Tool | Family | What it answers | The caps that bind it |
|---|---|---|---|
| `brain_status` | read | files/nodes/edges/languages, resolved + dropped refs, cache economics, generation + dirty | index caps: `BRAIN_MAX_FILES` 50 000 · `BRAIN_MAX_FILE_BYTES` 1 MiB — beyond them the whole project refuses `too-large`, never a half-index |
| `query_graph` | read | nodes by kind/name-glob/file, cursor-paginated, stable order | page 50 default / 200 max; `truncated: true` is load-bearing (no silent caps) |
| `get_node` | read | one node + signature + `fileHash` (the CAS handshake's truth) | response cap 64 KiB |
| `get_neighbors` | read | edges touching a node, direction-labeled | fan-out capped 500 |
| `shortest_path` | read | BFS path between two nodes | depth 8 default / 16 max · visited cap 4 000 — too-deep refuses, typed |
| `find_symbol` | read | defs by exact name then glob, `matchedBy` labeled | page caps as above |
| `find_references` | read | reference edges into a name's defs; ambiguity dropped AND counted in `note` | page caps as above |
| `get_repo_map` | read | the ranked repomap (§6) under a character budget | budget 200–16 000, default 4 000 |
| `list_libraries` | read | lockfile truth: version, pinned, direct, installed | scan cap 150 deps/ecosystem |
| `get_library_docs` | read | docs at the **pinned** version, from disk; `fetch:true` is consent-gated | README stored ≤ 64 KiB (flagged) · 200 signatures · fetch ≤ 1 MiB |
| `replace_symbol_body` | write | swap a def's body atomically | grant + own-checkout + file-CAS (`expectedFileHash`; `stale` refusal carries the fresh hash) |
| `insert_after_symbol` / `insert_before_symbol` | write | anchored insert, indentation preserved | same three locks; single-file, atomic-or-refused, re-indexed before the reply |
| `search_memories` | read | `.memory/` search — `exact` (FTS5 bm25) by default; `semantic`/`hybrid` only under the lens law | limit 20 default / 100 max; optional closed-grammar `filter` (≤ 8 AND clauses) |
| `get_memory` | read | one memory: body, tags, properties, backlinks | property law: ≤ 32 sorted keys, values ≤ 500 chars |
| `find_backlinks` | read | who links here — answers for **unwritten** targets too (a dangling link is valid) | page caps as above |
| `suggest_connections` | read | fixed-weight overlap arithmetic (links 3 · tags 2 · title terms 1), breakdown served | limit 10 default / 50 max |
| `recall_memories` | read | curated memories ranked against a **task** (§6) | limit 5 default / 20 max; drafts excluded by topology |
| `create_memory` / `update_memory` | write | team memory in the caller's own `.memory/` | grant + slug law + create-`exists` + update-CAS |
| `promote_memory` / `discard_memory` | write | the draft quarantine's two doors (§5) | grant; promote moves bytes verbatim; discard refuses on anything promoted |

`brain_status`, the repomap, and recall also have **paneless doors** —
`mogging map` and `mogging recall` ([docs/06-control-api.md](06-control-api.md))
serve the same one dispatch, so scripts and hooks can pre-brief a pane without
MCP. The CLI is paneless by nature, so it is always the exact base — no door
ranks differently from another.

---

## 4. Determinism, and what the lens law bounds

The same tree always yields the same graph; the same query the same rows
(`BRAINGRAPH` asserts byte-identical canonical dumps across rebuilds).
Rankings are arithmetic with the **breakdown served back** — repomap PageRank,
suggestion overlap weights, recall's bm25 + boosts all return components that
SUM to the score. An unexplainable ranking is a bug.

The lens law (revision A) is the one bounded amendment: semantic memory search,
optional draft distillation, and recall's hybrid blend exist **only** for a
consenting workspace (`brain.semanticMemory`, default OFF), on the user's own
OpenAI-compatible endpoint + model (both empty until typed — no bundled model,
no default endpoint, no proxy, no metering), key at rest under the
[ADR 0007.a](adr/0007a-usage-keys-at-rest.md) vault pointer grammar. Every fuzzy
hit is labeled with `probabilistic: true`, provider, model, and score; hybrid
components sum under fixed-weight RRF. Vectors live in the brain db,
content-hash keyed (an unchanged memory never re-embeds; a model swap
invalidates honestly). **BYO or absent** — a failed embed falls back to exact,
typed and labeled, and the deterministic path never bends: `mode: 'exact'`
short-circuits into the sync dispatch byte-identically.

---

## 5. Custody

- **Reads are free; writes ride the grant.** All disk mutation over MCP —
  symbol writes, memory writes — sits behind the per-workspace granted-writes
  toggle (the Phase-8 write wall, [docs/14-integrations.md](14-integrations.md)):
  no grant → the write tools are absent from `tools/list` AND a forced call
  refuses naming the grant. Every write call, landed or refused, leaves ONE
  trail event — verb + outcome only, never a path, a symbol, or a byte of
  content (ADR 0005).
- **Own checkout only.** A write names a node or slug in the caller's own
  checkout; a sibling worktree's is refused even under a project-scoped read
  session — reads may see the sibling, writes never touch it.
- **File CAS.** Symbol writes and memory updates carry `expectedFileHash`;
  a stale claim refuses with the **fresh** hash riding the refusal (the
  board's refuse-with-fresh-card shape, for files), and a refused write leaves
  the disk untouched. Landings are atomic-or-refused and synchronously
  re-indexed, so the reply already carries the new generation.
- **The memory-flow stance.** Memories live per checkout but read
  project-wide: the freshest indexed copy across the project's roots wins and
  every answer is root-labeled. Writes land in the caller's own `.memory/`
  only; **git is the sync** — branch, merge, review, and blame work on
  knowledge exactly as they work on code. There is no delete tool for a
  curated memory: removing one is a human's `git rm`.
- **The quarantine** (revision C). Auto-captured drafts land in
  `.memory/drafts/` — the ONE subdirectory that is ours — **git-invisible**
  until promoted (a self-ignoring `.memory/.gitignore` is written on first
  landing and never overwritten). Drafts are second-class by construction:
  own tables, ranked below every curated hit with `draft: true` + provenance,
  and excluded from suggestions, the semantic lens, and recall **by topology**
  (no curated query can see the draft tables). `promote_memory` moves the file
  bytes-verbatim into `.memory/` proper — the one door into git;
  `discard_memory` deletes a draft only. Retention is capped
  (`BRAIN_MAX_DRAFTS` 200 + a max age) and every eviction is **counted**,
  surfaced in the overview — never silent.

---

## 6. The repomap, and recall — memory reaches the agent

**The repomap** (Aider's algorithm, clean-room: tree-sitter + PageRank over
the reference graph, deterministic damping, fixed tiebreaks): file paths +
definition signatures, ranked, under a character budget. Three doors — the
`get_repo_map` tool, `mogging map`, and the **board-launch injection**: with
`brain.orientAtLaunch` ON (per workspace, default ON), a board-launched pane's
first prompt opens with a ` ```repomap ` fence, generation-stamped, typed
visibly through the same send path as the task — never a hidden channel
([docs/18-board.md](18-board.md)).

**Recall** (revision D) is the second launch section: "what the team knows" —
`recall_memories` ranks curated memories against the task's text (FTS5 bm25
over OR-joined terms + fixed-weight tag and capped backlink boosts, breakdown
served), and the launch block carries the top hits as `name — description`
lines ONLY, closed by an attribution stamp naming mode + generation. A body
byte in a first prompt is a review rejection — the pane can `get_memory` what
it wants. **ONE character budget — the repomap's own constant — binds BOTH
sections**: memories fill first, the map takes the remainder and yields
entirely below its own minimum, so recall can never inflate spawn cost past
the repomap ceiling. The knob is `brain.recallAtLaunch` (default ON), active
only under `orientAtLaunch`. Usage truth: every recalled slug and every full
agent read bumps a per-slug counter — a db column, never the file — shown
sortable in the Brain view so the **human** prunes; there is no automatic
decay and no probabilistic forgetting, ever.

---

## 7. The Brain view

`Ctrl+Shift+M`, or the palette's "Brain" row. Status card (files, nodes,
edges, languages, resolved/dropped refs, parse-cache economics, memory +
draft + skip counts, generation + dirty chip); the focus lens (a
force-directed neighborhood around any search hit, depth 1–3,
reduced-motion honored); the memory reader (properties panel, wikilink hover
previews, drafts section with promote/discard, usage counters); and every
consent in one place — orient-at-launch, recall-at-launch, library-doc
fetches, semantic memory + BYO endpoint/model/key. The view's reads go
through the same serve dispatch as the agent wire — same caps, same
envelopes, same refusals; no second, softer door.

---

## 8. Budgets, measured here

The perf claim is measured on the **composed** surface, not a quiet fixture:
`BRAINMILESTONE` forces a full re-index of a 5 000-file fixture **while 16
live panes run**, and the [docs/05](05-perf-budget.md) +
[docs/07](07-perception-budget.md) budgets must hold — worst frame gap
≤ 150 ms, zero frames over 100 ms, renderer heap ≤ 300 MB — with pane
responsiveness proven by a round-trip echo under load. Worker isolation is
the whole answer: parsing happens off-thread, landings are transactional, and
the UI thread never carries the index. The measured numbers live in the
freeze table (`prompts/phase-12/README.md`), re-measured at every
certification.

---

## 9. Proven by

Sixteen gates own the pack — fifteen env-gated smokes plus one static — and
`BRAINMILESTONE` is the only authority on "Phase 12 done": one fixture world
composing every promise end to end (shared index economics across worktrees,
the oriented launch, graph truth over real MCP, freshness under a real
agent's write, granted atomic symbol writes with a stale retry refused,
offline pinned-version docs, git-carried memory, the full capture → promote →
recall arc with a labeled semantic find, the budgets under load, telemetry
hygiene, and custody — zero grantless writes, zero real-network sockets, the
daemon protocol number equal before and after).

| Gate | Owns |
|---|---|
| `BRAINCORE` | identity, lifecycle, status, typed refusals |
| `BRAINPARSE` | the WASM parser fleet + catalog honesty |
| `GRAMMARCAT` (static) | catalog ↔ artifacts ↔ ADR roster agreement |
| `BRAINGRAPH` | graph truth, determinism, partitions, cache economics, caps |
| `BRAINFRESH` | the freshness law live: ticks, deltas, dirty, reconcile |
| `BRAINMCP` | the read family over real MCP from real panes |
| `BRAINMAP` | the repomap + launch injection + `mogging map` |
| `BRAINWRITE` | symbol writes: grant, CAS, own-checkout, atomicity, trail |
| `BRAINDOCS` | lockfile truth + disk docs + consent-fenced fetch |
| `MEMGRAPH` | `.memory/`: wikilinks, search, suggestions, granted writes, merge |
| `BRAINUX` | the view: doors, focus lens, reader, consents |
| `BRAINSEM` | the lens law: consent, labels, content-hash vectors, key custody |
| `BRAINPROPS` | the vault stance: properties, the filter grammar, skips |
| `BRAINCAP` | the capture law: drafts, quarantine, promote/discard, retention |
| `BRAINRECALL` | the recall organ: ranking, the shared budget, usage, CLI |
| `BRAINMILESTONE` | everything above, composed — the pack's freeze authority |

The sweep stands at **183 gates (160 app-boot + 23 static)** — the number is
`scripts/check-gate-count.mjs`'s derived output, the only authority.

Full laws and their rationale: [ADR 0018](adr/0018-workspace-brain.md)
(+ revisions A–D). Roadmap entry:
[docs/02-mvp-and-roadmap.md](02-mvp-and-roadmap.md) §Phase 12.
