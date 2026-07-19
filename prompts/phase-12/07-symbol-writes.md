Panes edit BY SYMBOL (Serena's shape) — custody first: every mutation
sits behind the per-workspace granted-writes, is CAS-guarded against
a stale graph, lands atomically, stays inside the caller's own
checkout, and leaves a trail event. The board's revision-CAS
discipline, applied to files.

## Steps
1. **The write family** (`brain/writes.ts`, served like 05):
   `replace_symbol_body { id, expectedFileHash, body }` — swap
   exactly the node's line range; `insert_after_symbol` /
   `insert_before_symbol { id, expectedFileHash, text }` —
   whole-line insertion at the range boundary, indentation from the
   anchor line. THAT IS THE SET — rename_symbol stays deferred in
   ADR 0018 (cross-file blast radius).
2. **The guards, in order, each a typed refusal**: (a) grant — the
   session's workspace must hold the granted-writes
   (`grant-store.ts`; the mcp bin already gates board writes on it —
   the brain family rides the same check + `tools/list_changed`
   flip); (b) scope — the target node's `root` must equal the
   CALLER'S checkout root, never a sibling worktree
   (`wrong-checkout`); (c) CAS — `expectedFileHash` must match the
   file's CURRENT bytes on disk (hashed fresh at write time, not
   from the db): mismatch → `stale` carrying the new hash, the agent
   re-queries first (the board's refuse-with-fresh-card shape);
   (d) sanity — file exists, is text, under the byte cap; body ≤
   64 KB.
3. **The landing**: write via `write-file-atomic` (shipped dep);
   re-index THAT file synchronously in the worker (the 04 unit) so
   the write's answer is the NEW generation + the node's new id —
   the agent's next query is already true. Response: `{ ok,
   generation, node, newFileHash }`. A trail event
   (`integrations/trail.ts`) records verb + counts, never paths or
   content (ADR 0005).
4. **Refusal honesty in the bin**: grantless sessions don't SEE the
   write tools (absent from `tools/list`; a direct call still
   refuses — the board precedent); pane-less sessions get no
   writes, period (pane identity is the custody anchor).
5. **BRAINWRITE smoke** (`MOGGING_BRAINWRITE`, dispatch branch,
   qa-smokes.sh row): real MCP client + 03 fixture — (a) no grant:
   tools absent AND a forced call refuses; (b) grant on:
   `tools/list_changed` observed; replace_symbol_body lands — bytes
   exact (fixture-known before/after), generation bumped, the new
   node queryable immediately; (c) stale: mutate the file via shell
   first → refusal carries the fresh hash; disk untouched by the
   refused write (byte-compare); (d) wrong-checkout: a worktree-B
   node id from a worktree-A session refuses; (e) insert_after
   preserves indentation on a nested method; (f) hostile body
   (`$(rm -rf)`, backticks, CRLF mix) lands as INERT BYTES — nothing
   executes, the file round-trips exactly; (g) exactly N trail
   events, zero paths in any telemetry call; (h) kill the app
   mid-write-storm, relaunch → no torn file (every file old or new,
   never mixed). Verdict `out/brainwrite-result.json`.

## Files
- `brain/writes.ts` · `serve.ts` (write routing) ·
  `bin/mogging-mcp.mjs` (writes behind the grant) · trail wiring ·
  `smokes/brainwrite-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINWRITE green; the sweep count grows by one in the books.
- ZERO new grant UI — the existing granted-writes toggle now covers
  brain writes; its plain-language copy says so.
- Board write gates + CONNPURE green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (incl.
  check-credential-wording if copy moved); the seven brain gates
  green in isolation.

## Guardrails
- No write without grant + CAS + own-checkout — three locks, no
  bypass argument, no force flag.
- Atomic or refused: a partial write may not exist on any path,
  including crash paths.
- The write set is closed — new verbs need an ADR revision.
