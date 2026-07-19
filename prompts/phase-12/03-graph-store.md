The graph itself: schema, a full deterministic build in the worker,
per-checkout partitions so sixteen worktrees can disagree without
lying, and a content-addressed parse cache so identical bytes are paid
for ONCE across all of them.

## Steps
1. **Schema** (`brain/schema.ts`, versioned migration in `store.ts`):
   `files(root, path, hash, lang, bytes, mtime, gen)` · `nodes(id,
   root, kind, name, file, startLine, endLine, sig)` — kind ∈ closed
   union {module, class, interface, type, function, method, enum,
   const} · `edges(src, dst, kind, root)` — kind ∈ {defines, imports,
   references, extends, implements} · `parse_cache(lang, fileHash,
   nodesJson, edgesJson)` · `meta`. Node id = sha1 of `(root, file,
   startLine, name, kind)` — STABLE: same bytes → same ids →
   byte-identical dump, the determinism proof.
2. **Extraction** (`extract.ts`, worker-side): run 02's `.scm`
   queries over the tree → defs become nodes; imports resolve
   deterministically (relative specifiers; tsconfig `paths` for TS;
   package specifiers become one `module` node each); references
   resolve name+import-scope BEST-EFFORT: a resolved ref is a
   `references` edge, an ambiguous one is DROPPED and counted —
   fidelity reported (`resolvedRefs`/`droppedRefs` in status), never
   faked.
3. **The walk** (`walk.ts`, worker-side): repo roots enumerate via
   `git ls-files -z --cached --others --exclude-standard` (gitignore
   respected for free); non-repo folders walk with the dot-rule +
   default ignores (node_modules, .git, dist, out, build); caps from
   contracts — over-cap is a typed `too-large` refusal carrying
   counts. Binary sniff → skip, counted.
4. **The build** (`indexer-worker.ts` grows): full build = walk →
   hash → parse-or-cache → extract → batched transactional inserts
   (1000-row chunks); ONE generation bump at commit, ONE
   `brain:changed`. **Per-checkout partitions**: every row carries
   `root`; a project's worktrees each get their partition in the
   SAME db; `parse_cache` is keyed `(lang, fileHash)` GLOBALLY — the
   second worktree's identical files insert from cache, no parse
   (hit-rate counted in status). Main thread: post a message, get
   progress — nothing else (frame-safety is 11's measured claim,
   built here).
5. **BRAINGRAPH smoke** (`MOGGING_BRAINGRAPH`, dispatch branch,
   qa-smokes.sh row): fixture TS+py repo with known truth — (a)
   node/edge counts exact; a class, its method, an import chain, a
   cross-file reference each present with correct kinds+lines;
   (b) rebuild → the canonical dump (ordered SELECT) byte-identical;
   (c) add the repo as a second worktree, index → cache hit-rate
   100% for unchanged files, partitions disjoint by `root`; (d) a
   gitignored file absent; node_modules absent in the folder
   fixture; (e) an ambiguous reference dropped AND counted; (f) an
   over-cap fixture refuses `too-large` with counts, db untouched.
   Verdict `out/braingraph-result.json`.

## Files
- `brain/schema.ts` + `extract.ts` + `walk.ts` + `store.ts`
  (migration) + `indexer-worker.ts` + `index.ts` (`rebuild()`) ·
  `smokes/braingraph-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINGRAPH green; the sweep count grows by one in the books.
- Status reports real files/nodes/edges/languages + fidelity + cache
  hit-rate; BRAINCORE/BRAINPARSE green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; the three brain
  gates green in one isolation run.

## Guardrails
- Determinism is asserted, not assumed — the byte-identical dump is
  the gate's spine.
- No watcher, no incremental path this step (04 owns freshness); a
  second `rebuild()` during one in flight → typed `busy` refusal.
- The db never lives inside any checkout; `.mogging`/`.memory` are
  walk-ignored (09 carves `.memory/` back in for itself).
- Zero network; daemon + renderer untouched.
