The Brain starts at the LAWS, not the graph. Codify ADR 0018, cut
the contracts, ship the per-project brain service every later step
consumes — identity, lifecycle, status, typed refusals — proven by a
fixture smoke, zero UI, zero parsing.

## Steps
1. **ADR 0018 — the workspace brain: one graph, many readers**
   (`docs/adr/0018-workspace-brain.md`). Stances, with rationale:
   (a) *determinism* — an index, not an oracle: no LLM, embeddings,
   vector store, cloud, or account; every answer reproducible from
   bytes on disk; (b) *derived state* — the index
   lives in the app data dir (`brain/<projectKey>.db`), deletable +
   rebuildable, never in the repo; (c) *per-PROJECT identity* — the
   board-v2 rule (worktrees share one brain; folders get folder
   identity); (d) *freshness is a law* — answers stamp `{generation,
   dirty}`; staleness surfaced, never silent (04);
   (e) *custody* — reads free to every pane, ALL disk mutation over
   MCP behind the per-workspace grant (07/09); (f) *daemon
   untouched* — an app service + a `worker_threads` indexer over
   the EXISTING endpoint relay (`bin/mogging-mcp.mjs`); nothing new
   listens (ADR 0008(b)); (g) *WASM-only parsers* —
   `web-tree-sitter`; native refused with rationale; (h) ADR 0005 —
   paths/symbols/memory text never in telemetry. Deferrals:
   LSP-grade resolution, cross-project graphs, rename-symbol.
2. **Contracts** (`src/contracts/ipc/brain.ipc.ts` +
   `BrainChannels` in `channels.ts` → `AllChannels`): `brain:status
   ({ root }) -> BrainStatus | BrainRefusal`; `brain:rebuild`;
   event `brain:changed ({ projectKey, generation, dirty })`.
   `BrainStatus { ok: true, projectKey, roots, generation, dirty,
   files, nodes, edges, languages, indexing }` · `BrainRefusal
   { ok: false, reason: 'missing'|'invalid'|'too-large'|'busy',
   detail? }` · caps as consts (`BRAIN_MAX_FILES = 50_000`,
   `BRAIN_MAX_FILE_BYTES = 1_048_576`). Closed unions, no `any`.
3. **Backend** (`src/backend/features/brain/`, Electron-free):
   `project.ts` — resolve a root to `projectKey` + sibling worktree
   roots (REUSE the board-v2 identity helper from
   `workspace/board-rows.ts` — extract, don't fork; board bytes
   identical after); `store.ts` — open/create the per-project db
   (better-sqlite3, WAL), `meta(schema_version, generation)` only;
   `index.ts` — `BrainService`: lazy instances, LRU-capped at 4
   open dbs, `status()`, `dispose()`.
4. **Main** (`src/main/brain.ts`): `registerBrain()` validates
   shape (junk → `invalid`, never throw), binds the verbs; register
   in `src/main/index.ts`. Db under the userData layout.
5. **BRAINCORE smoke** (`MOGGING_BRAINCORE`, dispatch branch,
   qa-smokes.sh row): fixture repo + linked worktree + plain folder
   — (a) repo and worktree resolve to the SAME projectKey; the
   folder gets its own; (b) status answers zeroed counts + a real
   generation; (c) the db exists under userData, NOT under either
   root; (d) refusals: missing path, junk shape; (e) dispose closes
   handles; (f) BOARDV2 still green. Verdict
   `out/braincore-result.json`.

## Files
- `docs/adr/0018-workspace-brain.md` · `brain.ipc.ts` ·
  `channels.ts` · `src/backend/features/brain/` · board identity
  extraction · `src/main/brain.ts` + `index.ts` ·
  `smokes/braincore-smoke.ts` · qa-smokes row

## Definition of Done
- BRAINCORE green; the sweep count grows by one in the books.
- The ADR states every stance + deferrals + a paragraph of research
  lineage (RESEARCH.md).
- No UI changed; BOARDV2 and PROTOVER green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (AUDIT · SPACING
  · PTYSEAM · PROTOVER · CHANNELS); the new gate in isolation.

## Guardrails
- No parser, walker, or watcher this step — lifecycle only.
- Zero network; daemon untouched; no new listener of any kind.
- The db schema is `meta` alone — 03 owns the graph.
