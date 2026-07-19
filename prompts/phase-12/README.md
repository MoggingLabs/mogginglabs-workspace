# Phase 12 — The Workspace Brain (the differentiator, finally)

Sequenced task prompts for Phase 12 of **MoggingLabs Workspace**: sixteen
agents in one workspace each re-scan the same tree, re-discover the same
symbols, and burn their first 20k tokens learning what the pane next door
already knows. This pack builds the **Brain**: one context service per
PROJECT (the board-v2 identity — a repo's worktrees share it), mounted
into every pane over the house MCP server, holding a deterministic
tree-sitter **code graph**, a ranked **repomap** injected at spawn,
**symbol-level writes** behind the grant, version-correct **library
docs**, Phase 2.5's `.memory/` wikilink graph — kept whole, at last
built — and the full cipher/ByteRover memory arc: a **semantic lens**
(BYO provider, opt-in), **auto-captured dual memory** (knowledge +
reasoning drafts), and **recall at spawn**. References, each taken for
its best organ (sourced receipts: `RESEARCH.md`; lineage:
`docs/research/2026-07-vibe-coding-ecosystem.md` §4): Graphify (the
deterministic local graph, MIT), Serena (symbol-level operations, MIT),
Aider's repomap algorithm (tree-sitter + PageRank, clean-room),
Context7 (version-correct docs, shape only — ours is local-first),
Obsidian's wikilink grammar (format, not code), cipher/ByteRover
(memory capture + semantic recall — Elastic-2.0, so SHAPE ONLY,
clean-room; the asciinema format-only precedent). Same format as
`prompts/phase-1..11/` (each step self-contained + pasteable as a
`/goal`, **≤ 3900 chars**). Execute in order.

> **The determinism law (codified as ADR 0018 in step 01, binding on
> every step)**: the Brain is an INDEX, not an oracle. No LLM, no
> embeddings, no vector store, no cloud, no account — the only kind of
> brain a free, local-first, offline app can promise. Every answer is
> reproducible from bytes on disk; the whole index is derived state in
> the app's data dir — deletable, rebuildable, never committed, never in
> the repo. Parsers are WASM (`web-tree-sitter`) — zero native-ABI
> churn on Electron bumps, by construction.

> **The freshness law — how the Brain stays up to date with the repos it
> extracts knowledge from**: three organs, one per knowledge source.
> (1) *The workspace repo*: event-driven incremental re-index riding the
> EXISTING 2.5s GitMonitor porcelain tick (`git/probe.ts` — the
> phase-11/05 move: parse what we already pay for) + head-move delta
> re-index; every answer stamps `{generation, dirty}` so staleness is
> visible, never silent. (2) *Third-party libraries*: versions come from
> LOCKFILES (exact, deterministic, offline), docs from the installed
> packages on disk; a lockfile change re-resolves on the same tick.
> (3) *Upstream shapes* (grammar releases): a committed, hash-pinned
> catalog + `catalog:grammars:update/check` script pair — the
> agent-settings-catalog precedent, so drift is a red gate, not a
> surprise.

> **Custody**: reads are free to every pane (ADR 0008); every disk
> mutation over MCP — symbol writes, memory writes — sits behind the
> per-workspace granted-writes (`grant-store.ts`), CAS-guarded, atomic,
> confined to the calling pane's own checkout. The daemon is UNTOUCHED:
> the Brain lives in the app (backend service + a `worker_threads`
> indexer), served through the existing endpoint relay
> (`bin/mogging-mcp.mjs`); nothing new listens (ADR 0008(b)). Paths,
> symbol names, and memory text never enter telemetry (ADR 0005).

> **The lens law (ADR 0018 revision A, cut in step 11)**: the Brain is
> deterministic BY DEFAULT; probabilistic lenses (semantic search,
> distillation) exist only opt-in per workspace, on the USER'S OWN
> provider + key (BYO — we never proxy, never meter, take no cut),
> labeled `probabilistic: true` on every hit, and NEVER the truth
> layer — the offline core and every deterministic tool are
> byte-identical with the lens off.

> **Numbering**: this pack takes ADR **0018** (+ revision A),
> `docs/20-brain.md`, and fifteen new gates — fourteen smokes + one
> static (the grammar-catalog check) — sweep **159 → 174** as of
> authoring, 2026-07-18 (159 is `check-gate-count.mjs`'s derived
> output, the only authority); steps say "grows by one/two" so the
> pack survives other work landing first. Phase-9 (authored, holding)
> keeps `docs/15-loops.md` + ADR 0009 untouched. Amended 2026-07-19:
> step **11b** (the Obsidian alignment) inserted after 11 — fifteen
> smokes + one static now; per-step deltas unchanged.

## Sequence
| # | File | Gate |
|---|------|------|
| 01 | `01-adr-and-brain-core.md` | ADR 0018 + contracts + per-project brain service, status verbs, typed refusals; BRAINCORE green, zero UI |
| 02 | `02-parser-fleet.md` | web-tree-sitter + vendored hash-pinned grammar catalog + the update/check script pair; BRAINPARSE + the static row green |
| 03 | `03-graph-store.md` | The SQLite graph — schema, full deterministic build in a worker, per-checkout partitions + content-addressed parse cache; BRAINGRAPH green |
| 04 | `04-freshness.md` | The freshness law implemented — git-tick incremental re-index, head-move deltas, generation stamps; BRAINFRESH green |
| 05 | `05-graph-mcp-tools.md` | The read tools on the house MCP server — query_graph/get_node/get_neighbors/shortest_path/find_symbol/find_references/brain_status; BRAINMCP green |
| 06 | `06-repomap-injection.md` | PageRank repomap: MCP tool + `mogging map` + opt-in board-launch first-prompt injection; BRAINMAP green |
| 07 | `07-symbol-writes.md` | Symbol-level writes behind the grant — CAS on file hash, atomic, own-checkout only, trail events; BRAINWRITE green |
| 08 | `08-library-docs.md` | Lockfile-pinned library docs from installed packages, opt-in network refresh, per-version cache; BRAINDOCS green |
| 09 | `09-memory-graph.md` | `.memory/` — markdown + `[[wikilinks]]`, backlinks, FTS5 search, deterministic suggestions, granted writes; MEMGRAPH green |
| 10 | `10-brain-ux.md` | The Brain view — status, force-directed graph lens, memory reader, consent toggles; BRAINUX green |
| 11 | `11-semantic-memory-lens.md` | The cipher lens — ADR 0018 rev A, BYO embedding seam + vault-held key, in-db vectors, exact/semantic/hybrid search, labeled; BRAINSEM green |
| 11b | `11b-obsidian-alignment.md` | The Obsidian alignment — ADR 0018 rev B (the vault claim), indexed frontmatter properties + a search filter grammar, wikilink hover previews, graph depth, skipped-files honesty; BRAINPROPS green |
| 12 | `12-auto-capture.md` | Dual memory auto-capture — knowledge + reasoning drafts from session/merge/card signals, quarantine + granted promote, optional BYO distillation; BRAINCAP green |
| 13 | `13-memory-recall-at-spawn.md` | Recall — `recall_memories` + `mogging recall`, the second injection section at board launch, usage counters; BRAINRECALL green |
| 14 | `14-brain-milestone.md` | `docs/20-brain.md` + gallery completeness + BRAINMILESTONE end-to-end (incl. the cipher arc) + budgets re-measured; pack freeze |

## Overall Definition of Done
- A pane's agent can ask the Brain (over real MCP) what defines a
  symbol, what neighbors it, what path connects two nodes, which exact
  library versions the project pins, and what its team already learned
  (`.memory/`) — every answer deterministic, generation-stamped, and
  scoped to the caller's checkout.
- A board-launched agent starts ORIENTED: a token-budgeted ranked map in
  its first prompt (opt-in, visible), instead of 20k tokens of
  rediscovery.
- The Brain is NEVER stale silently: an agent's `git commit`-less file
  write appears in the graph within a tick; a branch switch re-indexes
  the delta only; `dirty` is honest in every answer and in the UI.
- Sixteen agents share one index: identical files across worktrees parse
  ONCE (content-addressed cache, hit-rate measured); a full re-index
  never blocks a frame (worker-isolated, budget-proven).
- The memory works WITHOUT being asked: a real session auto-drafts
  what happened (knowledge + reasoning), a granted promote makes it
  team truth, the next launched agent is briefed with it, and — lens
  on — a vague query still finds it. Drafts never reach a prompt.
- Custody holds by construction: no MCP mutation without the grant; no
  write escapes the caller's checkout; the daemon protocol is unchanged.
- Both perf budgets unchanged (MILESTONE + PERCEPTION re-measured with
  the Brain live under 16 panes); all fifteen gates green on local
  Windows + all three CI OSes.

## Global checks (every step)
- `npm run typecheck` → 0; `npm run build` → ok; static gates green
  (AUDIT · SPACING `--max 0` · PTYSEAM · PROTOVER · CHANNELS).
- The step's env-gated smoke green via `scripts/qa-smokes.sh` isolation;
  MILESTONE + PERCEPTION re-run after any renderer-touching step.
- Gallery states staged for every new visual surface (both themes).

## Guardrails
- **Deterministic or absent** — no probabilistic answer ships; a lens we
  cannot make reproducible is deferred with rationale, not faked.
- **Derived state stays out of the repo** — the index lives in the app
  data dir; only `.memory/` (human-owned markdown) is committable.
- **Offline is the default** — the network organs (08's docs refresh,
  11/12's BYO provider) are opt-in per workspace with the house
  consent language, and requests leave ONLY for the user's own
  configured endpoints; every smoke runs with zero real network (FAKE
  embedder/provider fixtures).
- **Caps + typed refusals everywhere** — file count, file size, response
  size, BFS depth; junk input refuses, never throws.
- **Tokens only; AA measured** for every new ink/fill pair, both themes;
  reduced-motion honored in the graph view.
- **Symbol names and paths are user content** (ADR 0005): telemetry gets
  counts and booleans only.
- **Budgets are the veto** — a smarter index that costs frame time
  loses.

## Parallelization
01 → 02 → 03 → 04 is the spine. After 05 (the tools), three lanes:
Lane A (06 repomap), Lane B (07 writes + 09 memory → 11 lens → 12
capture), Lane C (08 docs). 10 needs 05 + 09; 11b needs 09 + 10 + 11
and is independent of 12; 13 needs 06 + 09 + 12; 14 needs everything.
Solo execution runs 01 → 14 in order (house rule: no parallel
agents).

---

## THE FREEZE (2026-07-19) — Phase 12 closed by BRAINMILESTONE

Every gate the pack owns, green on the closing bytes, in one targeted
battery on local Windows (per-gate isolation, fresh daemon each):

| Gate | | Gate | | Gate | |
|---|---|---|---|---|---|
| BRAINCORE | ✅ | BRAINWRITE | ✅ | BRAINPROPS | ✅ |
| BRAINPARSE | ✅ | BRAINDOCS | ✅ | BRAINCAP | ✅ |
| GRAMMARCAT | ✅ | MEMGRAPH | ✅ | BRAINRECALL | ✅ |
| BRAINGRAPH | ✅ | BRAINUX | ✅ | BRAINMILESTONE | ✅ |
| BRAINFRESH | ✅ | BRAINSEM | ✅ | | |
| BRAINMCP | ✅ | BRAINMAP | ✅ | | |

Plus every gate the pack could disturb, same battery, all green:
BOARDV2 · BOARDMCP · BOARDQUEUE · TREEGIT · TREELIVE · MCP · MCPWRITE ·
MCPSTATUS · MCPLOOP · MCPMGR · MCPCAT · MILESTONE · PERCEPTION — and
ALL 23 statics (AUDIT → GRAMMARCAT), typecheck 0, build ok. The sweep
registry derives **174 gates** (`check-gate-count.mjs`, 13 claims
agree). One honesty note: FUSES (a probe of the PACKAGED artifact in
`dist/`, bytes this pack never touches) was green in the session's
first full statics pass and then flaked red on the closing re-run —
the documented machine-AV condition from the wizard-folder-layout
freeze, environmental, to be verified on the CI dispatch below.

### The measured numbers (BRAINMILESTONE's composed world, Win11)

| Claim | Measured | Budget |
|---|---|---|
| Fixture indexed, per checkout | 5 018 files | ≥ 5 000 |
| Cold full index (repo, worker) | 3.2 s | — |
| Sibling worktree parse-cache hit-rate | **100% / 100%** | ≥ 90% |
| Freshness: real pane write → queryable, dirty 0 | **3.5 s** | ≤ 5.75 s (2 ticks + quiet) |
| Memory merge → visible from sibling pane | 0.7 s | polled, ≤ 4 ticks |
| Frames DURING full 5k re-index + 16 live panes | **143 avg fps · 14 ms worst gap · 0 > 100 ms** | ≥ 30 fps · ≤ 150 ms · 0 |
| Renderer heap under the same load | 30 MB | ≤ 300 MB |
| Forced full re-index wall time (touched 5k) | 7.2 s | — |
| Echo round-trip through a pane under load | 6.2 s | lands, polled |
| MILESTONE (16-pane ANSI torrent) | 137.3 fps · 138.9 ms worst · 57 MB | ≥ 30 · ≤ 150 · ≤ 300 |
| Daemon protocol before/after | 10 = 10 | unchanged |
| Telemetry with fixture markers | 0 calls carry any | 0 |
| Write trail | replace ok · stale refused · create ok · promote ok | exact |

### Platform finds (Windows, recorded for the CI dispatch)

1. **The creation-lineup race.** A `agents.detected` replay (or a real
   hand-typed agent detected) within ~900 ms of a template-opened
   workspace is recorded as the slot's manifest assignment
   (`noteAgentLaunch`) — and the still-pending creation lineup then
   reads the LIVE array and types a REAL launch into the pane, whose
   TUI takes the alternate screen and wipes the composed first prompt.
   The step gates never saw it (their polling replays later by
   accident); the milestone waits the window out on purpose. A product
   hardening (snapshot the lineup at creation, or have the recorder
   skip slots with a pending lineup) is a candidate follow-up, not a
   pack blocker.
2. **cmd.exe capture reflow.** Wrapped input is re-echoed with cursor
   jumps and OVERLAP fragments at the wrap column ("session-3-" + CSI +
   "-node") — a needle can be on screen yet never contiguous in the
   bytes. Capture assertions must strip ANSI and match wrap-tolerantly;
   the milestone pairs that with the compose seam's byte-exact truth.
3. **MCPWRITE was latently red since brain/13**: `recall_memories`
   grew the served non-write roster 38 → 39 and the smoke's pinned
   count was not bumped. Caught by this battery, fixed here
   (`mcpwrite-smoke.ts`), re-run green — the disturbed-gates
   discipline earning its keep.
4. **Leaked gate daemons hold `sessions.db`** across isolated runs
   (Windows file locks): teardown must kill the worktree's own
   `mogging-node … daemon.js` by command line — never by image name,
   never the installed app's.

### Certification — honest table

| Environment | Status |
|---|---|
| Local Windows: the 16 pack gates + 13 disturbed + 23 statics (one targeted battery, pre-merge bytes) | ✅ green (2026-07-19) |
| Local Windows: the same battery + 9 merge-touched gates (LIBRARYUX · SETINTEG · INTEGUX · PLAINMENU · AGENTLAUNCH · LAUNCHNOW · UPDATEOFFLINE · NOTIFYPARITY · RAILFOLD), on the bytes MERGED with main (182-gate registry) | ✅ green (2026-07-19; three chunk-contention flakes healed on serial rerun) |
| BRAINMILESTONE bite-proof on merged bytes | ✅ severed orientation → RED on exactly launchOk+recallOk; restored → green |
| MILESTONE (Phase-2 grid gate) on this machine | ⚠️ red with the IDENTICAL signature on **pure main** (`domHidden 1` — the flicker work's covered-panes-keep-leases law under an occluded gate window — + one ~150–160 ms frame). Inherited machine/occlusion condition, not this pack; BRAINMILESTONE's own perf arm (frames + heap, occlusion-pinned) is green. Verify on CI. |
| FUSES (packaged-artifact probe) on this machine | ⚠️ machine-AV condition (passed earlier same session on identical `dist/` bytes). Verify on CI. |
| Local Windows: the FULL uncut 182-gate sweep | **PENDING** (operator — Claude never runs the full sweep) |
| Three-OS CI dispatch (`ci.yml`, gates empty = all 182) | **PENDING** (operator) |

The book: `docs/20-brain.md`. Laws: ADR 0018 + revisions A–D.
Roadmap: `docs/02-mvp-and-roadmap.md` §Phase 12 (shipped-form note),
`README.md` roadmap row, `prompts/README.md` row 12.
