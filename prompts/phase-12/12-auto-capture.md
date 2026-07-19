The cipher shape, organ two: DUAL MEMORY, auto-captured. Agents
should not have to be told to remember — the app already watches
every session (command blocks, exit codes, review merges, board
cards); capture drafts memories FROM those signals. Knowledge memory
(what was learned) + reasoning memory (how it was solved),
quarantined as drafts until promoted. Clean-room, shape only.

## Steps
1. **Deterministic capture** (`brain/capture.ts`): zero LLM in the
   base path — drafts are STRUCTURED data from signals we already
   own: *reasoning drafts* from a pane's command-block ladder
   (commands, exit codes, the failure→retry→fix arc) on session
   end; *knowledge drafts* from a review merge (touched symbols
   via the graph, the card's task, the branch) and a board card
   reaching Done. Frontmatter `auto: true, source:
   session|merge|card`, generated slug, structured body (lists,
   not invented prose). Triggers ride EXISTING emitters (trail,
   board, blocks) — zero new watchers.
2. **Optional distillation**: consent `brain.captureDistill`
   (default OFF) lets 11's BYO seam (a chat-completions sibling
   adapter) compress a structured draft into prose — output ADDS
   `distilled: true` + provider/model to frontmatter; the
   structured body is kept below the prose (truth survives the
   summary). No consent → structured drafts only; FAKE provider in
   smokes.
3. **The quarantine**: drafts land in `.memory/drafts/<slug>.md` —
   indexed and searchable (ranked BELOW curated, flagged on every
   hit), EXCLUDED from suggest_connections and from 13's recall
   until promoted. `promote_memory { slug }` (granted write, 07's
   guards) moves the file into `.memory/` proper;
   `discard_memory { slug }` (granted) deletes a DRAFT only. The
   Brain view's reader gains a Drafts section with
   promote/discard.
4. **Retention honesty**: caps (`BRAIN_MAX_DRAFTS`, max age),
   oldest-out eviction, counted in status — never silent; promoted
   memories are permanent (no auto-delete path EXISTS).
5. **BRAINCAP smoke** (`MOGGING_BRAINCAP`, dispatch branch,
   qa-smokes.sh row): a REAL scripted pane runs a fail→fix arc, a
   board card completes — (a) both draft kinds exist with exact
   structured fields (the failing command + exit code present);
   (b) search finds drafts, ranked below a curated fixture memory,
   `draft: true` on the hit; (c) drafts absent from
   suggest_connections AND a recall probe; (d) grantless promote
   refuses; granted promote moves the file, suggestions now
   include it; (e) discard on a promoted slug refuses; on a draft,
   deletes; (f) distill OFF → zero provider calls (spied); ON with
   FAKE → prose present, structured body preserved, labeled;
   (g) cap: N+5 drafts → 5 evictions, counted; (h)
   `.memory/drafts/` contains only `.md`. Verdict
   `out/braincap-result.json`.

## Files
- `brain/capture.ts` + retention · drafts routing in `memory.ts` ·
  `serve.ts` + `bin/mogging-mcp.mjs` (promote/discard, granted) ·
  Brain view Drafts section · distill consent card ·
  `smokes/braincap-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINCAP green; the sweep count grows by one.
- After one real session, the Drafts section shows an honest,
  readable record of what happened — verified by hand (the
  manual-first rule).
- MEMGRAPH · BRAINSEM · board gates green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; the pack's
  gates green in isolation.

## Guardrails
- Capture is from signals, never from scraping pane text wholesale
  — command blocks and trail events are the vocabulary.
- Drafts are second-class BY CONSTRUCTION until a granted promote —
  no auto-promotion path exists.
- Distillation never replaces structure; provider output is labeled
  and additive.
- Captured command lines pass the existing redaction rules before
  any draft is written.
