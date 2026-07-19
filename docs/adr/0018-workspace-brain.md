# ADR 0018 — The workspace brain: one graph, many readers

- **Status:** Accepted (2026-07-18). Step 02 of the brain plan ships the LAWS below —
  identity, lifecycle, status, typed refusals (`BrainService`, `brain:*`, the BRAINCORE
  gate) — before any graph exists, so every later step inherits them instead of
  retrofitting them. **Revision A (2026-07-19)** adds the LENS LAW — the one bounded
  amendment to stance (a) — for the semantic memory lens. **Revision B (2026-07-19)**
  records the VAULT STANCE: `.memory/` is an Obsidian-compatible vault by
  construction, with properties, a closed filter grammar, and honest skips.
  **Revision C (2026-07-19)** adds DUAL MEMORY, AUTO-CAPTURED: structured drafts
  from signals the app already watches, quarantined in `.memory/drafts/` until a
  granted promote — and grows the closed memory-write set by exactly the two
  draft verbs (`promote_memory`, `discard_memory`). **Revision D (2026-07-19)**
  adds the RECALL organ: `recall_memories` ranks curated memories against a
  task (deterministic base, hybrid only under revision A's consent), the
  launch orientation gains its second budgeted section, and per-slug usage
  counters inform the human — no automatic forgetting, ever.
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
- **Rename-symbol.** Step 07 (2026-07-18) landed the symbol-level write surface under
  stance (e)'s custody answer — a CLOSED three-verb set (`replace_symbol_body`,
  `insert_after_symbol`, `insert_before_symbol`), each single-file, grant-gated,
  own-checkout-scoped, file-CAS-guarded (`expectedFileHash`, refusing `stale` with the
  fresh hash), atomic-or-refused, and synchronously re-indexed so the answer carries
  the new generation. **The write set is closed by the catalog validator: growing it
  is a revision of this ADR, not a code change.** Rename stays deferred — its
  cross-file blast radius over a syntactic graph is a find-and-pray, and we don't
  ship those.

## The memory lens (step 09, Phase 2.5) — the memory-flow stance

The brain's one HUMAN-legible surface: `.memory/` — a wikilink knowledge graph
the TEAM owns. Everything above stays true of it; what follows is the custody
answer this step adds, recorded here because every clause is load-bearing:

- **Files are the truth; the index is disposable.** Memories are plain markdown
  at `<projectRoot>/.memory/<slug>.md` — frontmatter `name` (the slug),
  `description`, optional `tags`; the body's `[[wikilinks]]` target other
  slugs. They live IN the repo (the one deliberate exception to stance (b)'s
  "nothing of ours lands in the user's tree" — these are the USER'S bytes, we
  just read them), so **git is the sync**: branch, merge, review, and blame all
  work on knowledge exactly as they work on code. No db, index, or dotfile
  machinery inside `.memory/`, ever — the brain db's `memories`/`memory_links`/
  FTS5 tables are a derived shadow, rebuilt whole from one scan.
- **A dangling link is VALID.** A `[[link]]` to an unwritten slug marks wanted
  knowledge and is queryable (`find_backlinks` answers for unwritten targets);
  backlinks are DERIVED from the index and never stored in the files.
- **Memory-flow custody.** Memories live per checkout but READ project-wide:
  the freshest indexed copy across the project's roots wins and every answer
  is root-labeled — never anonymous, never narrowed (a scope argument would
  hide a teammate's fresher copy). Writes land in the CALLER'S own checkout's
  `.memory/` only — the slug law (kebab-case filenames, one flat dir) makes
  any other path unspellable — and git merges them home.
- **Deterministic or absent.** Search is FTS5 bm25 (fixed tiebreaks);
  `suggest_connections` is fixed-weight overlap arithmetic (shared links 3,
  shared tags 2, shared title terms 1) with the full breakdown served back —
  an unexplainable ranking is a bug, per stance (a).
- **Closed sets, one wall.** Four reads (`search_memories`, `get_memory`,
  `find_backlinks`, `suggest_connections`) join the reads-free family; two
  writes (`create_memory`, `update_memory`) sit behind the SAME per-workspace
  grant as every write, with 07's guards (create refuses `exists`; update is
  file-CAS with the fresh hash riding the `stale` refusal; landings are
  atomic-or-refused and indexed before the reply). The sets are closed by the
  catalog validator; growing either is a revision of this ADR — and revision C
  below is exactly that, adding the two draft verbs (`promote_memory`,
  `discard_memory`). There is no delete tool for a curated memory — removing
  one is a human's `git rm`.
- **Privacy (h), unchanged.** Memory text reaches the calling model only; the
  trail carries verb + outcome, counts only.

Proven by **MEMGRAPH** (`MOGGING_MEMGRAPH`, verdict `out/memgraph-result.json`):
hostile-name create lands sanitized and inert; wikilinks/backlinks/dangling
exact; FTS order stable across runs; suggestions arrive with their breakdown;
stale CAS refuses with the disk untouched; a real pane edit reindexes on the
tick; a worktree merge carries a memory home through REAL git; no grant means
writes refuse while reads answer; a deleted brain db rebuilds search from the
files alone; `.memory/` holds only `.md` files afterwards.

## Revision A — the LENS LAW (the semantic memory lens, Phase 2.5)

Stance (a) said "no LLM, no embeddings, no vector store" — and it stays true of
the CORE, whose every answer remains reproducible from bytes on disk. What the
brain lacked was fuzzy RECALL over `.memory/`: FTS5 does not stem, so a vague
question misses the note that answers it. This revision bounds (a) instead of
repealing it: a **probabilistic LENS may exist over the deterministic core**,
under four conditions that are each structural, not disciplinary:

- **(A1) Opt-in.** The workspace consented (`brain.semanticMemory`, per
  workspace, default OFF — the library-fetch card's consent semantics). No
  consent → semantic modes refuse `consent`, typed; nothing embeds, ever.
- **(A2) The user's OWN provider.** ADR 0002's spirit, applied to inference: we
  never proxy, never meter, take no cut. ONE adapter — OpenAI-compatible HTTP
  (`POST <endpoint>/embeddings`) — covers OpenAI, Azure, Ollama, LM Studio;
  a local endpoint makes even the lens fully offline. There is **no bundled
  model and no default endpoint**: both fields are empty until the human types
  them, and no request leaves for anywhere else (the guardrail is the absence
  of any other URL in the path). The key at rest rides ADR 0007.a's vault
  pointer grammar verbatim — OS-vault ciphertext or an env-ref NAME, never a
  plaintext in a config file, never a getter channel.
- **(A3) Labels are load-bearing.** Every fuzzy hit carries
  `probabilistic: true` plus the `provider` (endpoint host) and `model` that
  scored it, and its `score`; hybrid hits carry the full blend breakdown
  (fixed-weight reciprocal-rank fusion of the FTS list and the cosine list —
  the two components SUM to the score). An unlabeled probabilistic answer is a
  review rejection. Fuzzy, but still auditable.
- **(A4) The deterministic path does not bend.** `search_memories` defaults to
  `mode: 'exact'` — step 09's dispatch, byte-identical; semantic/hybrid live in
  a separate handler the sync dispatch never learns about. Exact search,
  backlinks, suggestions, and the whole offline core answer identically with
  the lens on, off, or broken.

**The mechanics, recorded:** vectors live in the brain db (`memory_vectors`,
one row per written slug — the project's freshest copy, the same election every
read serves), **content-hash keyed**: an unchanged memory never re-embeds (the
skip is counted), a changed hash replaces the row, and a model swap invalidates
honestly (rows are model-stamped and never served under another model's name).
Embedding rides step 04's drain — consent ON only, debounced, off the exclusive
queue so HTTP never dams a write. Similarity is house cosine, in process, over
the db — **no external vector store, no new service, no new dependency**. Query
embeds happen per call, capped. Failures are typed (`embed-failed`), abort the
pass, and surface as ONE toast per latch — never a retry loop.

**Lineage + license stance.** The shape is the memory organ of
ByteRover's **cipher** (Elastic-2.0): semantic recall over a team knowledge
store, BYO embedding provider. Elastic-2.0 is a **code wall** for this tree —
the shape is taken clean-room, the code is refused, the asciinema
format-only precedent (docs/02 §risk 5) applied again: read the docs, never the
source, implement from the laws above.

Proven by **BRAINSEM** (`MOGGING_BRAINSEM`, FAKE embedder — a deterministic
seeded-hash trigram embedding, zero network — verdict
`out/brainsem-result.json`): consent OFF refuses typed while exact answers
byte-identically; a fixture pair with FTS-disjoint vocabulary is found by
semantic and missed by exact (the value, proven); every fuzzy hit is labeled
and hybrid components sum; an unchanged re-drain embeds nothing (counted) and
one edit embeds exactly one; a model swap re-embeds on the next drain; the
pasted key resolves in process while its plaintext greps to ZERO files at rest;
and the lens off leaves step 09's surface untouched.

## Revision B — the Obsidian alignment (the vault stance)

Step 09 chose plain markdown, one-line frontmatter, and filename-resolved
`[[wikilinks]]` for `.memory/` — which happens to be, clause for clause, the
format Obsidian's millions of users already know. This revision makes that
alignment a RECORDED LAW instead of a coincidence, in three clauses:

- **(B1) An Obsidian-compatible vault BY CONSTRUCTION.** The same wikilink
  syntax, the same frontmatter tags, links resolved by FILENAME (the slug IS
  the filename; the dir is flat) — so pointing Obsidian at
  `<checkout>/.memory/` gives its editor, backlinks, graph, and search for
  free, and **git stays the sync** (no Obsidian Sync, no plugin, no
  dependency, nothing of Obsidian's in the tree). Obsidian — and its Bases
  properties/filter shape — is a SHAPE target only, a code wall harder than
  Elastic-2.0's (the app is proprietary): read the conventions, never the
  code. And one convention is refused FOREVER: executable query blocks
  embedded in notes. A memory is inert bytes; bytes that run queries are a
  lens hiding inside data, and every lens here is a verb with laws.
- **(B2) Foreign files are counted, never indexed.** Obsidian (or any editor)
  drops non-slug filenames, attachments, and config dirs into a vault. The
  scan already SKIPPED everything that is not `<slug>.md`; it now COUNTS what
  it skips — `memory_scan(root, invalid, too_large, foreign_files, capped)`,
  replaced whole per rescan, and the rescan fingerprint includes the counts,
  so a newly-appeared skipped file still lands a rescan rows alone would not.
  The app SHOWS the count (`brain:overview.memorySkips`, the Brain view's
  "Memory files skipped" row, only when nonzero): stance (a)'s "refused
  honestly", applied per file.
- **(B3) Properties, and the one filter.** Frontmatter lines beyond the
  reserved three (`name`, `description`, `tags`) are PROPERTIES — Obsidian's
  own convention, parsed under a fixed law: one `key: value` per line, last
  occurrence wins, values control-stripped and capped
  (`MEMORY_PROP_VALUE_MAX = 500`), keys SORTED, the first
  `MEMORY_MAX_PROPS = 32` kept; a malformed KEY line stays a whole-file
  `invalid` (the parse law is unchanged). Properties are inert bytes end to
  end: indexed (`memory_props`), served by `get_memory` as `properties`,
  rendered textContent-only — never interpreted. Over them, `search_memories`
  gains ONE optional `filter` string with a CLOSED grammar — data, not code:
  comma-joined AND clauses, at most 8; `#tag` (tag membership) · `key`
  (property presence) · `key=value` (exact; the value runs to the comma).
  Reserved keys and junk refuse `invalid`, typed and teaching; zero matches
  answer `ok:true` with an empty list; the filter applies in EVERY mode
  BEFORE ranking; and a filter-absent call answers byte-identically to
  step 09's dispatch.

Proven by **BRAINPROPS** (`MOGGING_BRAINPROPS`, verdict
`out/brainprops-result.json`): a 40-property memory serves exactly 32 sorted
keys with last-wins and capped values; the whole filter matrix (`=`,
presence, `#tag`, AND, a miss answering `ok:true` empty, reserved/junk
refusing typed); the filter composing with semantic AND hybrid modes with
their probabilistic labels intact; a filter-absent hit carrying not one new
field; `memorySkips` counting a seeded invalid + foreign file and a
runtime-ADDED foreign file landing through the skips-aware fingerprint; and
the reader's properties panel (hostile values inert), the 250ms wikilink
hover preview (shows, hides, Escapes, never for dangling), graph depth
1|2|3 with depth 2 byte-identical to the default fetch, and the skipped
row on screen.

## Revision C — dual memory, auto-captured (the capture law)

Agents should not have to be told to remember. The app already WATCHES every
session — command blocks (OSC 133: commands + exit codes), review merges,
board cards reaching Done — and this revision captures draft memories FROM
those signals: *reasoning* drafts (how it was solved — the ladder, its
failures, the failure→retry→fix arcs) from a pane's block ladder at session
end, and *knowledge* drafts (what was learned — touched files/symbols via the
graph, the card's task, the branch) from a merge landing or a card reaching
Done. Four clauses, each structural:

- **(C1) Deterministic capture.** ZERO LLM in the base path: a draft's body is
  lists derived from the signals (`brain/capture.ts`), never invented prose;
  frontmatter carries `auto: true` + `source: session|merge|card` as inert
  props under revision B's parse law. Triggers RIDE EXISTING EMITTERS — the
  renderer's block tracker at pane end, the board's lane-change registry, the
  review merge handler — zero new watchers. Capture reads command blocks and
  board/merge facts only, never scraped pane text, and every command line
  passes the house secret redaction before it can land.
- **(C2) The quarantine.** Drafts land in `.memory/drafts/<slug>.md` — the ONE
  subdirectory that is ours — and are second-class BY CONSTRUCTION: indexed in
  their own tables, and **git-invisible until promoted**: the first landing
  writes a self-ignoring `.memory/.gitignore` (`drafts/` — the
  `.mogging/.gitignore` precedent; never overwritten, so a user's own ignore
  file wins). Two laws hang on that byte: an unreviewed auto-capture never
  propagates to the team through git, and an untracked draft never dirties
  the repo — the review merge gate's clean-repo law stays open with drafts
  standing. Promotion is the one door into git: the moved file is ordinary
  untracked team memory, commit-ready. Beyond that, drafts are indexed in
  their own tables (`memory_drafts`, its FTS shadow), searchable but ranked
  BELOW every curated hit with `draft: true` + provenance on each one, and
  EXCLUDED from `suggest_connections`, from the semantic lens, and from recall
  — not by discipline but by topology (no curated query can see the draft
  tables). Two granted verbs are the only doors: `promote_memory` moves the
  file bytes-verbatim into `.memory/` proper (a non-draft refuses; a curated
  collision refuses `exists`); `discard_memory` deletes a DRAFT only — a
  promoted memory refuses, because **promoted memories are permanent: no
  auto-delete path exists** and curated deletion stays a human's `git rm`.
  Both join the closed memory-write set (the catalog validator holds it) —
  this revision IS the ADR revision that growth demands. The Brain view's
  reader gains a Drafts section (read, promote, discard — the human's own
  surface, same engine locks).
- **(C3) Optional distillation, additive and labeled.** Consent
  `brain.captureDistill` (per workspace, default OFF) + a chat model let
  revision A's BYO seam — a chat-completions SIBLING adapter, same endpoint,
  same vaulted key, FAKE endpoint for every smoke — compress a structured
  draft into prose. The output ADDS `distilled: true` + provider/model to the
  head and the prose above the body; **the structured body always survives
  below it** (truth survives the summary). No consent → structured drafts
  only and zero provider calls (spied); a distill failure lands the
  structured draft unchanged, typed and quiet.
- **(C4) Retention honesty.** Caps are contracts (`BRAIN_MAX_DRAFTS`, a max
  age), eviction is oldest-out, and every eviction is COUNTED
  (`memory_draft_stats`, surfaced in `brain:overview` and the status card) —
  never silent. Retention touches only the quarantine, by construction.

Proven by **BRAINCAP** (`MOGGING_BRAINCAP`, verdict
`out/braincap-result.json`): a REAL scripted pane emits a fail→fix OSC 133
arc through the REAL PTY and its session end lands a reasoning draft with the
exact failing command + exit code and the fixed arc; a Done card lands a
knowledge draft; search ranks both below a curated fixture with `draft: true`
on every draft hit; suggestions and the FAKE-embedder recall probe never see
them; grantless promote refuses while a granted promote moves the file
bytes-verbatim and suggestions then include it with a fixture-known
breakdown; discard refuses on the promoted slug and deletes the draft;
distill OFF spies zero provider calls and ON (FAKE) lands labeled prose over
the preserved structure with zero sockets; a cap of N with N+5 landings
counts the evictions; and `.memory/drafts/` holds only `.md` files.

## Revision D — the RECALL organ (memory reaches the agent)

Steps 09–C built a memory the team can WRITE and SEARCH; what was missing is
memory that ARRIVES: a new pane starting already knowing what the team
learned, and a working agent asking "what do we know about this?" in one
call. `recall_memories { task, limit? }` joins the read family — CURATED
memories ranked against the task's text — and the 06 orientation block gains
a second fenced section carrying the top hits. Four clauses, each structural:

- **(D1) Deterministic by default.** The base rank is arithmetic: FTS5 bm25
  over the task's terms (OR-joined — a task is prose, not a conjunction) plus
  fixed-weight boosts for matched tags and for backlink count (capped, so
  popularity seasons relevance and never replaces it), and the full breakdown
  rides every hit — components that SUM to the score (the suggest engine's
  auditability law). Under revision A's lens law, the workspace's semantic
  consent upgrades the blend to HYBRID (the fixed-weight RRF, every hit
  labeled `probabilistic` with provider + model); no consent, no config, or a
  failed embed falls back to exact and the reply's `mode` says which truth
  happened. Drafts appear in NO mode — revision C's quarantine is table
  topology, and recall reads only the curated tables.
- **(D2) The injection stays visible and bounded.** The launch section —
  "what the team knows" — carries `name — description` lines ONLY (a body
  byte in a first prompt is a review rejection; the pane can `get_memory`
  what it wants), closed by an attribution stamp naming mode + generation.
  ONE character budget — the repomap's own constant — binds BOTH sections:
  memories fill first (cheaper than signatures), the map takes the remainder
  and yields entirely below its own minimum, so recall can never inflate
  spawn cost past 06's ceiling. The knob is `brain.recallAtLaunch` (per
  workspace, default ON) and it is ACTIVE ONLY under `orientAtLaunch` —
  recall rides the orientation block, it never outlives the opt-out. The
  bytes are typed visibly through the same send path as the task, never a
  hidden channel.
- **(D3) Usage truth, not usage judgment — a stance under revision A's lens
  law.** Every slug a recall answer carries and every full agent read
  (`get_memory` over the wire) bumps a per-slug counter — a DB COLUMN
  (`memory_usage`), never the file, because usage is derived observation, not
  team knowledge. The Brain view shows the counts, sortable, so the HUMAN
  prunes dead memories. **There is NO automatic decay and NO probabilistic
  forgetting: the app never deletes or demotes a curated memory by these
  numbers** — the counters inform a human verb (`git rm`), exactly as C2 made
  deletion a human verb. The view's own reader deliberately does not count:
  the human browsing their vault is not usage; the counter informs that same
  human.
- **(D4) One ranking, three doors.** The MCP tool, the launch channel, and
  `mogging recall <task…>` (docs/06's register: `0` ok · `1` no brain ·
  `2` usage · `3` app down) all serve the ONE dispatch — scripts and hooks
  can pre-brief a pane without MCP, and no door ranks differently from
  another. The CLI is paneless by nature, so it is always the exact base.

Proven by **BRAINRECALL** (`MOGGING_BRAINRECALL`, verdict
`out/brainrecall-result.json`): a task naming a fixture term ranks its memory
first with the breakdown's components summing and the vocabulary-sharing
draft absent; a board launch with both toggles ON types map + memories
sections — combined within the one budget, attribution stamped — while
recall OFF keeps the map only and orient OFF injects nothing; hybrid answers
only under consent (FAKE embedder, labeled) and the exact world embeds
nothing (spied, zero sockets); no body sentinel ever reaches a composed
prompt; two recalls + one `get_memory` land exact per-slug counter deltas in
the view's data; and the CLI's exit codes hold the shared table.

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
