The Obsidian alignment: conventions users already know —
properties, hover previews, graph depth, honest skips — and
`.memory/` becomes a DOCUMENTED Obsidian-compatible vault. Shape
only (Obsidian/Bases = ⛔ code, concept only; query blocks in notes
refused forever). All deterministic — stance (a) whole.

## Steps
1. **ADR 0018 revision B**: (a) `.memory/` is an Obsidian-compatible
   vault BY CONSTRUCTION — same wikilinks, frontmatter tags,
   filename-resolved links — Obsidian's editor/graph/search work
   free, git stays the sync; (b) Obsidian saves non-slug filenames our
   scan SKIPS — counted, step 4 shows it; (c) properties + the
   filter grammar below, recorded. One sentence rippled into
   docs/02.
2. **Properties indexed** (memory.ts, db v7): head lines beyond the
   reserved three parse into `props` — last wins, values cleaned +
   capped (500), SORTED keys, first 32 win — both caps named
   consts. Tables `memory_props(root, slug, key, value)` +
   `memory_scan(root, invalid, too_large, foreign_files,
   capped)` (FOREIGN is SQLite-reserved), replaced whole per
   rescan, generation-neutral. The rescan FINGERPRINT must
   include skip counts — rows-only never lands an ADDED invalid
   file. get_memory serves `properties` (BRAINSEM stays green).
3. **The filter** (serve.ts + BOTH catalogs): search_memories gains an
   optional `filter` STRING (the validator speaks primitives):
   comma-AND clauses, max 8 — `#tag` (membership) · `key` (presence)
   · `key=value` (exact; values run to the comma). Reserved keys +
   junk refuse typed; zero matches = ok:true + []. Applies to EVERY
   mode BEFORE ranking; filter absent = byte-identical.
4. **Reader affordances** (view/reader/graph + css tokens):
   (a) a properties panel — sorted rows, textContent only;
   (b) wikilink HOVER PREVIEW — 250ms delay, focus/blur parity,
   Escape/scroll dismiss, name + description + snippet via the
   memGet door, cached per slug,
   generation-cleared, never for dangling, becalmed-safe; (c) graph
   DEPTH 1|2|3, default 2 = today's fetch EXACTLY; depth 3 = one
   more voted expansion under FOCUS_NODE_CAP; (d) "Memory files
   skipped" status row from overview's new memorySkips, only when
   nonzero.
5. **BRAINPROPS smoke** (MOGGING_BRAINPROPS, dispatch + SMOKE_ENV +
   qa row): chain a→b→c→d (a: status/priority/tag ops; b: status
   done; a 40-prop memory; a hostile VALUE — hostile KEYs are
   already whole-file-invalid) + one .txt + one non-slug .md.
   Prove: props sorted, capped at 32; the filter matrix
   (=, presence, #tag, AND, miss → ok:true empty, reserved/junk →
   typed invalid); composes with semantic AND hybrid (labels
   intact); filter absent adds no hit fields; memGet properties
   exact; memorySkips {invalid 1, foreign 1}; a runtime-ADDED
   foreign file lands (the skips-aware fingerprint); UI: panel rows
   exact, hostile value inert, preview shows/hides/Escapes, depth
   1/2/3 → 2/3/4 nodes, skipped row visible. Verdict
   out/brainprops-result.json.

## Files
- ADR 0018 (rev B) · docs/02 bullet · memory.ts/store/schema v7 ·
  index.ts fingerprint · serve.ts · main/brain.ts · mcp-catalog ×2 ·
  reader/view/graph/css · smokes/brainprops-smoke.ts · qa row

## Definition of Done
- BRAINPROPS green; sweep grows by one.
- MEMGRAPH + BRAINSEM + BRAINUX green unmodified.
- Hand-verified once: `.memory/` opened as an Obsidian vault —
  links, backlinks, graph, properties appear.

## Checks that must be green
- `npm run typecheck` → 0; build ok; statics (SPACING --max 0,
  wording, GATECOUNT); pack gates in isolation.

## Guardrails
- The filter is DATA with a closed grammar; properties are inert
  bytes — Bases is a shape, not a dependency.
- Byte laws: filter-absent search and depth-2 focus reproduce
  today's replies exactly; the reader stays textContent-only.
- No new verbs; caps named; silent truncation = review rejection.
