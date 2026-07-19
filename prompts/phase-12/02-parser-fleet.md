The parsers, and the discipline that keeps them current. Land
`web-tree-sitter` (WASM — the ADR 0018 stance: zero native-ABI churn),
a vendored hash-pinned grammar catalog, a worker-side parser pool, and
the update/check script pair that makes upstream grammar drift a red
gate instead of a surprise. No graph yet — parse trees in, tag counts
out.

## Steps
1. **Dep + artifacts**: add `web-tree-sitter` (runtime dep, MIT).
   Vendor prebuilt grammar `.wasm` files under `assets/grammars/`,
   committed (installs stay offline + deterministic). Starter roster:
   typescript, tsx, javascript, python, go, rust, java, c, cpp,
   c_sharp, ruby, php, bash, json, yaml, toml, html, css. Every
   artifact hash-pinned; total bytes asserted ≤ 25 MB by the check
   script.
2. **The catalog** (`src/backend/features/brain/grammars.json`): one
   row per language — `{ lang, wasm, sha256, version, sourceRepo,
   releaseTag, extensions[], licence }`. Extension → language routing
   derives from it; unknown extensions are an honest skip (counted,
   never an error). The catalog is DATA — adding a language is a row
   + an artifact, zero code.
3. **The freshness scripts** (the agent-settings-catalog precedent in
   `scripts/`): npm scripts `catalog:grammars:update` / `:check`.
   *update* (`scripts/update-grammar-catalog.mjs`, operator-run,
   network): per row, query the pinned `sourceRepo`'s published
   releases/npm for a newer grammar build, download, verify it loads
   + parses a probe snippet, rewrite hash + version + releaseTag.
   *check* (`scripts/check-grammar-catalog.mjs`, offline, a
   `run_static` row in qa-smokes.sh): every artifact exists, sha256
   matches, extensions unique across rows, licence present, roster
   prose in docs matches the catalog, total bytes under cap.
4. **The pool** (`brain/parser-pool.ts`, runs INSIDE the
   `worker_threads` indexer only — renderer and main never load a
   parser): lazy `Parser.init()` + per-language load on first use,
   LRU-capped live parsers (8), per-parse timeout + byte cap
   (`BRAIN_MAX_FILE_BYTES`); a failed/hung parse is a counted skip,
   never a crash. `parseFile(path, lang) -> { tree, tagCounts }`
   where tagCounts buckets defs/refs/imports via per-language queries
   (`assets/grammars/queries/<lang>.scm`, clean-room, the tags.scm
   SHAPE) — 03 consumes the same queries for extraction.
5. **BRAINPARSE smoke** (`MOGGING_BRAINPARSE`, dispatch branch,
   qa-smokes.sh row): fixture files per roster language — (a) every
   language parses; def/ref counts match fixture truth; (b) unknown
   extension skips, counted; (c) an oversized file skips, counted;
   (d) a corrupted temp copy of a wasm fails the CHECK script (run
   as a child, assert red); pristine catalog passes; (e) lazy load —
   status shows only touched languages; (f) all parsing happened in
   the worker (main-thread parse count = 0 via an instrumentation
   hook). Verdict `out/brainparse-result.json`.

## Files
- `package.json` (+dep, +catalog scripts) · `assets/grammars/*.wasm`
  + `queries/*.scm` · `brain/grammars.json` + `parser-pool.ts` +
  `indexer-worker.ts` (skeleton) · `scripts/update-grammar-catalog.mjs`
  + `check-grammar-catalog.mjs` · qa-smokes.sh (smoke row + static
  row)

## Definition of Done
- BRAINPARSE + the static catalog row green; the sweep count grows
  by two in the books.
- `catalog:grammars:update` run once by hand proves the pipeline.

## Checks that must be green
- `npm run typecheck` → 0; build ok (electron-vite bundles the
  worker; wasm resolves in dev AND packaged layouts — `asarUnpack`
  if needed); static gates incl. the new catalog check.

## Guardrails
- WASM only — a native tree-sitter binding is a review rejection.
- The update script never runs in CI or the sweep; the check script
  never touches the network.
- No graph schema, no walking, no watching this step.
