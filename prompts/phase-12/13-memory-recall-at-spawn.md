The cipher shape, organ three: RECALL — memory reaches the agent
without being asked for. A new pane starts knowing what the team
already learned; a working agent can ask "what do we know about
this?" in one call. Rides 06's injection door and 11's lens;
deterministic by default. Clean-room, shape only.

## Steps
1. **The tool**: `recall_memories { task, limit? }` joins the read
   family — rank CURATED memories against the task text:
   deterministic base (FTS bm25 + tag-match and backlink-count
   boosts, fixed weights, breakdown returned); when 11's consent
   is ON the blend adds cosine (hybrid, labeled per the lens law).
   Drafts are excluded ALWAYS (12's quarantine). Capped (default
   5, max 20), enveloped, generation-stamped.
2. **Spawn injection**: the 06 orientation block gains a SECOND
   fenced section — "what the team knows": top-K recall hits as
   `name — description` lines (titles + descriptions ONLY, never
   full bodies; the pane can `get_memory` what it wants). One
   shared character budget with the map (06's constant; the map
   yields last — memories are cheaper than signatures). Toggle
   `brain.recallAtLaunch`, default ON, active only when
   `orientAtLaunch` is ON; the section's attribution line stamps
   mode (`exact`/`hybrid`) + generation. Visible typing through
   the same send path — never hidden.
3. **Usage truth** (the memory-that-earns-its-place loop, kept
   deterministic): a per-slug counter increments on every recall
   hit and `get_memory` read (db column, not the file); the Brain
   view shows it (sortable) so the HUMAN prunes dead memories —
   no automatic decay, no probabilistic forgetting, recorded as a
   stance in ADR 0018 rev A.
4. **CLI door**: `mogging recall <task…>` prints the same ranked
   list (exit codes per the docs/06 register) — scripts and hooks
   can pre-brief a pane without MCP.
5. **BRAINRECALL smoke** (`MOGGING_BRAINRECALL`, dispatch branch,
   qa-smokes.sh row): curated fixtures + one draft — (a) a task
   naming a fixture term ranks its memory first, breakdown
   returned, draft ABSENT; (b) board-launch with both toggles ON:
   the first prompt carries map + memories sections, combined ≤
   the budget, attribution stamped (captured via `mogging
   capture`); recall OFF → map only; orient OFF → neither;
   (c) hybrid mode only with consent (FAKE embedder), hits
   labeled; exact world runs with zero embed calls (spied);
   (d) bodies never injected — the sections contain no body text
   from any memory (byte-scan); (e) counters: two recalls + one
   get_memory → exact counts in the view's data; (f) `mogging
   recall` exit codes ok/no-brain/app-down. Verdict
   `out/brainrecall-result.json`.

## Files
- `brain/recall.ts` · `serve.ts` + `bin/mogging-mcp.mjs`
  (recall_memories) · `render.ts` (second section + shared
  budget) · launch/board seam reuse · toggle (contracts + card) ·
  `bin/mogging.mjs` (recall verb) + docs/06 row · usage counters
  (db + Brain view column) · `smokes/brainrecall-smoke.ts` ·
  qa-smokes.sh row

## Definition of Done
- BRAINRECALL green; the sweep count grows by one.
- A board card about a topic with a curated memory launches a
  pane that visibly knows it — verified once by hand.
- BRAINMAP · MEMGRAPH · BRAINCAP green unmodified; BOARDQUEUE
  untouched.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; the pack's
  gates green in isolation; PERCEPTION re-run (a view column
  landed).

## Guardrails
- Titles + descriptions only in injections — a full body in a
  first prompt is a review rejection (context hygiene).
- Drafts never reach a prompt, any mode, any toggle.
- One budget, shared with the map — recall may not inflate spawn
  cost past 06's ceiling.
- No automatic forgetting: counters inform the human; the app
  never deletes a curated memory.
