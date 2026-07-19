# Phase 12 — research receipts (distilled)

Full sweep + license table: `docs/research/2026-07-vibe-coding-ecosystem.md`
(§3 licenses, §4 "Why the graph, and why now"). This file records what each
reference contributes, what we refuse, and how the pack stays current with
the upstreams it learned from.

## The shapes we take (clean-room, always)

| Source | License | Organ taken | What we refuse |
|---|---|---|---|
| **Graphify** (~83k★) | MIT | The nucleus: local deterministic code graph — tree-sitter AST, no LLM/embeddings/vector store; graph query verbs (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) | Its runtime + storage; we ship house code on `better-sqlite3` (already compiled from source) |
| **Serena** (~26k★) | MIT | Symbol-level operations: find/read/replace **by symbol**, not blind file rewrite | Its LSP dependency — our v1 truth is the tree-sitter graph; LSP fidelity is a recorded deferral in ADR 0018 |
| **Aider** (repomap) | Apache-2.0 | The algorithm shape only: tree-sitter tags → reference graph → PageRank → token-budgeted ranked map at spawn | Any code; any LLM-side ranking |
| **Context7** (~59k★) | MIT | The *claim*: version-correct third-party docs kill hallucinated APIs | The cloud: ours resolves versions from lockfiles and reads docs from the packages already installed on disk; network refresh is opt-in |
| **Obsidian / wikilink grammar** | format only | `[[wikilinks]]`, backlinks, a force-directed lens over committed markdown | Any vault code; any proprietary format beyond plain `.md` |
| **cipher/ByteRover** (steps 11–13) | ⛔ Elastic-2.0 — **shape only, clean-room** (the asciinema format-only precedent) | The full memory arc: semantic recall over the memory store; dual memory (knowledge + reasoning); auto-capture from agent sessions; memory injected into a starting agent's context | EVERY line of its code (license); its always-on LLM dependency — ours is the lens law: deterministic by default, semantic/distill opt-in on the user's OWN provider+key, labeled, never the truth layer |
| **web-tree-sitter** | MIT | WASM parser runtime — no native ABI, no C++ toolchain tax on `npm install`, immune to Electron ABI bumps | Native `tree-sitter` bindings (would join the from-source build and break on every Electron major) |

⛔ Still not taken: mem0/graphiti (clean licenses, but embedding-centric
*truth layers* — their recall value is covered by the opt-in lens
without making probability the substrate).

## Why the graph (the economic claim)

A single-pane tool amortizes repo discovery over one agent; we amortize it
over sixteen. One index, built once, kept fresh incrementally, answered
over MCP to every pane: *many agents become cheaper per question than one
agent working badly.* That converts the core feature (many agents) from an
ergonomic story into an economic one — see the ecosystem report §4.

## Staying up to date with the upstreams (the freshness law's third organ)

The Brain **extracts knowledge from repos**; each source of extracted
knowledge has a named freshness mechanism — nothing goes stale silently:

1. **The workspace repo** (the knowledge itself): incremental re-index on
   the existing GitMonitor tick + head-move deltas; `{generation, dirty}`
   stamped on every answer (step 04).
2. **The user's dependencies** (docs knowledge): lockfile-pinned versions,
   re-resolved when the lockfile changes; per-`(name, version)` cache so a
   bump is a new entry, never a mutation (step 08).
3. **The grammar upstreams** (parsing knowledge): every vendored `.wasm`
   is hash-pinned in `grammars.json` with its source repo + release tag;
   `catalog:grammars:update` (operator-run, network) pulls newer published
   releases and re-pins; `catalog:grammars:check` (offline, a sweep static
   row) fails on hash drift, missing artifacts, or prose disagreeing with
   the catalog — the exact `agent-settings-catalog` precedent already in
   `scripts/`.
4. **The reference projects themselves** (shape knowledge): shapes were
   taken clean-room at authoring (2026-07-18, star counts above from the
   2026-07-12 sweep). They are inspiration, not dependencies — there is
   nothing to break; keeping up with their IDEAS is the watchlist below
   plus a periodic re-sweep of the ecosystem report.

## Watchlist — upstream shapes worth re-checking

Re-sweep cadence: with each phase pack authored, or quarterly,
whichever comes first. Per project, the release feed and the ONE
change that would make us revisit:

| Project | Watch | Revisit if |
|---|---|---|
| tree-sitter grammars (per `grammars.json` row) | each `sourceRepo`'s releases | any release — `catalog:grammars:update` handles it; this row is automated, the rest are editorial |
| Graphify | releases + README | a new query verb or index structure our graph can't answer |
| Serena | releases | it drops the LSP requirement or ships a symbol-edit verb we lack |
| Aider | repomap module changelog | a ranking change measurably better than PageRank-with-personalization |
| Context7 | releases + docs API | a local/offline mode appears (would widen 08 beyond disk+registry) |
| cipher/ByteRover | releases + blog | a new memory organ beyond capture/recall/semantic (e.g. cross-project memory federation) |
| mem0 / graphiti | releases | a deterministic or fully-local recall mode appears — would let the lens law admit them |

## Ground-truth seams this pack builds on

- Per-project identity + one-writer CAS: `docs/18-board.md`,
  `src/backend/features/workspace/board-rows.ts`.
- House MCP server + endpoint relay + granted writes:
  `bin/mogging-mcp.mjs`, `src/backend/features/integrations/grant-store.ts`,
  trail: `integrations/trail.ts`.
- The 2.5s git porcelain tick (freshness ride):
  `src/backend/features/git/probe.ts` (phase-11/05 precedent).
- Atomic writes: `write-file-atomic` (shipped dep). FTS5: bundled in the
  from-source `better-sqlite3` build.
- Spawn/first-prompt injection: board card launch ("the task IS the first
  prompt", phase-3) + `src/backend/features/agents/launch.ts`.
