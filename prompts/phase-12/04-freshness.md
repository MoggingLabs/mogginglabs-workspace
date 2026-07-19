The freshness law: the Brain follows the repo it extracts knowledge
from — event-driven, incremental, honest. No cron, no full rebuilds on
a timer, no silent staleness. This step is the pack's answer to "how
does it stay up to date": ride what we already pay for.

## Steps
1. **The ride** (`brain/freshness.ts`): the EXISTING 2.5s GitMonitor
   porcelain tick (`git/probe.ts`) already lists changed paths per
   tracked cwd — phase-11/05 parsed those lines for the explorer; the
   Brain subscribes to the SAME parsed batch (extend the existing
   emitter; zero new git spawns, zero new pollers). Changed/untracked
   paths → per-root dirty set; deletions → tombstones. Non-repo
   roots: a capped mtime sweep of known files on the same cadence,
   jittered — no new watcher machinery.
2. **Incremental apply** (worker-side): debounced (750ms quiet) drain
   of the dirty set → per path: delete its rows, re-hash,
   parse-or-cache, re-insert — one transaction per drain, ONE
   generation bump, ONE `brain:changed`. A drain never exceeds a
   slice cap (200 files); larger spills roll into the next drain with
   `dirty` still counted — honesty over heroics. `.memory/` and
   lockfile paths route to their own subscribers (08/09 attach; this
   step just routes).
3. **Head moves** (`head.ts`): the existing branch probe already
   surfaces HEAD per cwd — on a move (checkout, rebase, merge), diff
   old..new via one `git diff --name-only --find-renames` spawn (the
   ONLY new git invocation in the pack, fired on head-move only),
   feed the delta through the same incremental path. NEVER a full
   rebuild on a branch switch; the smoke counts reparsed files and
   asserts delta-only.
4. **Generation stamping**: every status/query answer (05 consumes)
   carries `{ generation, dirty }`; `indexing: true` while draining.
   `brain:rebuild` stays the explicit big hammer with its `busy`
   refusal. If the app was closed while files changed, first status
   after open reconciles by hash-compare against the walk (mtime
   prefilter) — cold-start staleness heals without a full reparse.
5. **BRAINFRESH smoke** (`MOGGING_BRAINFRESH`, dispatch branch,
   qa-smokes.sh row): fixture repo indexed, then a REAL shell pane
   (the FILESMILESTONE precedent) — (a) appends a new function to a
   tracked file → within ≤ 2 ticks the node exists, generation +1;
   coalescing proven: 20 rapid writes → 1–2 drains, counted;
   (b) deletes a file → nodes gone, tombstone applied; (c) branch +
   commit + switch back → reparsed count == the delta, not the tree;
   (d) dirty nonzero DURING the debounce window, zero after (polled,
   never slept — the retry-loop rule); (e) a non-repo root picks up
   an mtime change; (f) kill the app mid-dirty, relaunch → first
   status heals, counts match truth; (g) determinism holds
   post-incremental: rebuild == incremental result, byte-identical
   dump — the incremental path may not drift. Verdict
   `out/brainfresh-result.json`.

## Files
- `brain/freshness.ts` + `head.ts` + `indexer-worker.ts`
  (incremental verbs) · `git/probe.ts` (emitter extension — explorer
  bytes untouched) · `smokes/brainfresh-smoke.ts` · qa-smokes.sh row

## Definition of Done
- BRAINFRESH green; the sweep count grows by one in the books.
- The incremental result is provably identical to a rebuild.
- TREEGIT · TREELIVE · BRAINGRAPH green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates; the four brain
  gates green in one isolation run.

## Guardrails
- Zero new pollers, zero recursive watchers — the docs/05 law
  stands; the git tick and the explorer's machinery are not
  duplicated.
- One new git spawn TYPE (head-move diff) — never periodic.
- Coalesce or refuse: a write storm may never produce a drain storm.
- Staleness is DATA (`dirty`), never a blocking wait on any answer.
