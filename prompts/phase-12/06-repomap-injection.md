Cold panes start oriented. The repomap: PageRank over the graph we
already hold (Aider's algorithm shape, clean-room), rendered as a
budgeted ranked map, reachable three ways — MCP tool, `mogging map`,
and opt-in first-prompt injection at board launch.

## Steps
1. **The rank** (`brain/repomap.ts`, worker-side): build the symbol
   reference graph from `edges` (references + imports + extends
   weigh in), run PageRank (house implementation, ~40 lines,
   damping 0.85, FIXED 30 iterations — deterministic);
   personalization boost for symbols referenced from MANY distinct
   files (Aider's core insight). Rank is per-root, cached per
   generation — a stale cache is impossible by construction.
2. **The render** (`render.ts`): walk files by best-ranked symbol,
   emit `path:` then indented signature lines (sig from nodes, no
   bodies), greedily fill a CHARACTER budget (default 4000, max
   16000 — chars, not tokens: deterministic and CLI-neutral); whole
   lines only, never mid-line cuts; deterministic tiebreak (rank,
   path, line). Output ends with one attribution line:
   `[repomap: generation N, X/Y files]` — the honesty stamp.
3. **Three doors**: (a) MCP: `get_repo_map { budget? }` joins 05's
   read family (free, scoped, enveloped); (b) CLI: `mogging map
   [--budget N]` prints to stdout — exit `0` ok · `1` no brain for
   this cwd; shared codes hold (docs/06 table gains a row);
   (c) **board launch injection**: a per-workspace setting
   `brain.orientAtLaunch` (default ON) — when the board launches an
   agent into a pane (the task IS the first prompt, phase-3), the
   map is PREPENDED to that first prompt as a fenced block, visibly
   typed into the pane like the task itself — never a hidden env
   var, never silent. Wizard agent-launch panes get the same via the
   identical seam (`agents/launch.ts`); manual/bare panes untouched.
4. **Settings surface**: the toggle in Settings → the workspace card
   (house Card/FieldGroup, plain copy: "New board-launched agents
   start with a map of this project"). Off = zero injection bytes.
5. **BRAINMAP smoke** (`MOGGING_BRAINMAP`, dispatch branch,
   qa-smokes.sh row): 03's fixture has a known hub (a symbol
   referenced from 5 files) — (a) the hub's file leads the map; a
   zero-inbound leaf file is absent at budget 1000; (b) two renders
   byte-identical; rebuild → still identical (determinism through
   the cache); (c) budget respected: output ≤ budget chars, whole
   lines, attribution present; (d) `mogging map` exit codes: ok,
   non-brain cwd, app down; (e) board-launch, toggle ON: the pane's
   first prompt starts with the fenced map then the card task
   (proven via `mogging capture`); toggle OFF: first prompt IS the
   task, zero map bytes; (f) the attribution generation matches
   `brain_status`. Verdict `out/brainmap-result.json`.

## Files
- `brain/repomap.ts` + `render.ts` · `bin/mogging-mcp.mjs` ·
  `bin/mogging.mjs` + `bin/lib` (map verb) · `agents/launch.ts`
  (prepend seam) · board launch path · settings toggle · docs/06
  verb row · `smokes/brainmap-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINMAP green; the sweep count grows by one in the books.
- A board card launched into a real pane visibly starts with the
  map — verified once by hand before the smoke is trusted.
- BOARDQUEUE/BOARDV2 and the launch gates green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; the six brain
  gates green in isolation; PERCEPTION re-run (a settings card
  landed).

## Guardrails
- Deterministic end to end: fixed iterations, fixed tiebreaks — a
  flaky map is a broken map.
- Injection is visible typing through the EXISTING send path — no
  hidden context channel.
- Signatures only — never file bodies (renders from `nodes.sig`).
- Bare `mogging open` panes never receive unasked bytes.
