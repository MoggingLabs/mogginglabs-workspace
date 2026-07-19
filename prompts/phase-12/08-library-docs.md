The one thing a local graph cannot know — which EXACT third-party
versions this project runs, and what their APIs are. Context7's
claim, our custody: versions from lockfiles (deterministic, offline),
docs from the packages already installed ON DISK, network refresh
opt-in per workspace.

## Steps
1. **Version truth** (`brain/libraries.ts`): lockfile parsers —
   package-lock.json, pnpm-lock.yaml, yarn.lock (the shipped `yaml`
   dep), requirements.txt, poetry.lock, uv.lock, go.mod/go.sum,
   Cargo.lock — direct deps + exact pinned versions (transitives
   listed, not doc-indexed). Manifest-only projects degrade
   honestly: ranges reported AS ranges, `pinned: false`. Re-resolve
   rides 04's freshness routing when a lockfile lands in a drain.
2. **Docs from disk** (`libdocs.ts`, worker-side): per direct dep,
   read the INSTALLED package (node_modules/<name>: README*,
   package.json exports, bundled `.d.ts` distilled to signatures
   via 02's ts grammar; site-packages for py: top-level docstrings)
   into per-`(name, version)` cache tables in the brain db — a
   version bump is a NEW entry; entries no lockfile references are
   pruned on resolve. Not installed → `installed: false`, docs
   absent, honestly. Zero network on this path, by construction.
3. **Opt-in refresh** (`libfetch.ts`, main-side): a per-workspace
   consent (`brain.fetchLibraryDocs`, default OFF, house consent
   language + the phase-8 single-fire failure toast) unlocks ONE
   network verb: fetch a missing-from-disk dep's published README +
   types (npm/PyPI JSON endpoints only, pinned version, size-capped,
   https, no off-registry redirects) into the same cache. No consent
   → typed `consent` refusal. Smokes never touch the real net.
4. **The tools** (join 05's read family): `list_libraries {}` →
   `{ name, version, pinned, installed, hasDocs }[]` per ecosystem;
   `get_library_docs { name, topic? }` → the cached distillation
   (topic = heading filter), enveloped, size-capped, ALWAYS
   carrying `{ version, source: 'disk'|'registry' }` — an answer
   that cannot say its version does not ship.
5. **BRAINDOCS smoke** (`MOGGING_BRAINDOCS`, dispatch branch,
   qa-smokes.sh row): fixture with a package-lock + a fake installed
   dep (known README/types) + a py requirements pair — (a) versions
   exact per lockfile; the manifest-only fixture says `pinned:
   false`; (b) get_library_docs answers from disk, stamps version +
   `disk`; the known type signature present; (c) bump the lockfile
   via shell → re-resolve on the tick; old cache row pruned; new row
   `installed: false`; (d) consent OFF: the fetch verb refuses, zero
   sockets opened (the injection seam); consent ON against a LOCAL
   fixture registry: docs land, source `registry`, size cap held;
   (e) hostile dep names (`../../evil`, scoped `@a/b`) canonicalize
   or refuse — no path escape (the cache is keyed, not pathed).
   Verdict `out/braindocs-result.json`.

## Files
- `brain/libraries.ts` + `libdocs.ts` + `libfetch.ts` + cache
  schema rows · `serve.ts` + `bin/mogging-mcp.mjs` (two reads) ·
  consent toggle (contracts + Settings card) ·
  `smokes/braindocs-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINDOCS green; the sweep count grows by one.
- A real pane CLI answers the fixture dep's pinned-version API, not
  a guess — verified once by hand.
- The consent card reads plainly; the wording gate stays green.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (incl.
  check-credential-wording); the eight brain gates green in
  isolation.

## Guardrails
- Version-correct or version-silent — never an unversioned answer.
- The network organ is ONE verb, consent-gated, registry-pinned,
  size-capped; smokes run offline, always.
- No package code EXECUTION ever — reading files is the whole
  mechanism; no `require()`, no install hooks, no scripts.
