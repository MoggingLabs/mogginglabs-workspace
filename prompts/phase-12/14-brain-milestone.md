Close the pack: the book, gallery completeness, ONE composed
milestone proving the whole promise in one fixture world — then the
freeze. BRAINMILESTONE is the only authority on "Phase 12 done".

## Steps
1. **The book** (`docs/20-brain.md`): architecture (service +
   worker + db, per-project identity, the endpoint relay); the
   determinism + lens laws; the freshness law's three organs
   (workspace tick / lockfile re-resolve / grammar catalog
   scripts) — the "how it stays current" chapter is MANDATORY; the
   tool table (schemas, refusals, caps); custody (grant + CAS +
   own-checkout, memory-flow, quarantine); repomap + recall;
   budgets measured here. Cross-link ADR 0018 (+rev A),
   docs/06/14/18. README row flips to ✅; `docs/02` gets its
   shipped-form paragraph. Counts stay DERIVED — write what
   `check-gate-count.mjs` says.
2. **Gallery**: every Brain surface staged both themes;
   `check-audit.mjs` routing updated if rows were gained.
3. **BRAINMILESTONE smoke** (`MOGGING_BRAINMILESTONE`, dispatch
   branch, qa-smokes.sh row) — one fixture world, in order: (a) a
   repo + TWO worktrees index once — cache hit-rate ≥ 90% on the
   siblings, partitions disjoint; (b) a board card launches a REAL
   agent-shaped pane, orientAtLaunch ON → the first prompt opens
   with the map (captured), generation-stamped; (c) that pane
   answers find_symbol → get_neighbors → shortest_path on fixture
   truth; (d) a real shell pane appends a function → in
   ≤ 2 ticks the node is queryable, dirty settles to 0 (polled,
   never slept); (e) a granted replace_symbol_body lands atomically
   → the NEXT query sees the new node, trail counted; a stale retry
   refuses; (f) get_library_docs answers the dep at its pinned
   version, offline; (g) create_memory in worktree A + git merge →
   found from B; (h) the cipher arc: the fail→fix session
   auto-drafts, a granted promote lands it, the NEXT board launch
   injects it (recall section captured), and with FAKE-embedder
   consent a vocabulary-disjoint query finds it, labeled; (i) the
   perf claim: DURING a forced full re-index of the 5k-file
   fixture with 16 live panes, MILESTONE + PERCEPTION hold (worst
   gap ≤ 150ms, 0 frames > 100ms, heap ≤ 300MB) — worker
   isolation, measured; pane responsiveness by a round-trip echo
   under load; (j) ADR 0005: telemetry has zero paths, symbol
   names, or memory text; (k) custody: write verbs without the
   grant → zero; zero real-net sockets; the daemon protocol number
   equal before/after. Verdict `out/brainmilestone-result.json`.
4. **The freeze**: pack README gains the freeze section — gate
   table all ✅, the measured numbers (fps, worst gap, heap, index
   time, cache hit-rate, freshness latency), platform finds, the
   honest certification table: targeted gates green; the FULL
   sweep + three-OS CI dispatch stay PENDING the operator (Claude
   never runs the full sweep).

## Files
- `docs/20-brain.md` · `docs/02` · `README.md` (roadmap row) ·
  `prompts/README.md` (phase row) · gallery states ·
  `smokes/brainmilestone-smoke.ts` · qa-smokes.sh row · pack
  README (freeze)

## Definition of Done
- BRAINMILESTONE green; every count in prose matches
  `check-gate-count.mjs` output.
- All 14 pack gates + every gate they could disturb (BOARDV2 ·
  BOARDQUEUE · TREEGIT · TREELIVE · the MCP family · PROTOVER ·
  MILESTONE · PERCEPTION) green in one targeted run.
- The freshness chapter covers all three organs; the lens chapter
  states BYO/labeled/never-truth.

## Checks that must be green
- `npm run typecheck` → 0; build ok; ALL statics; the battery
  above; check-docs-refs on the new cross-links.

## Guardrails
- The milestone composes EXISTING gates' machinery — nothing lands
  here that a step gate didn't own in isolation.
- Any budget regression is a stop-ship, not a footnote.
- PENDING rows stay PENDING until the operator runs them.
