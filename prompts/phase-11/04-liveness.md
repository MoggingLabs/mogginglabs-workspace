The liveness law implemented (Phase-11/04): watch what's visible, nothing
else. An agent writing into an EXPANDED directory shows up within a second
as ONE coalesced update; everything else — collapsed dirs, hidden window,
closed explorer — costs exactly zero. No watcher library: per-dir
non-recursive `fs.watch` (node built-in) is the whole trick, with the house
jittered poll as the fallback tier (the VS Code watcher architecture,
RESEARCH §2/§6, minus the native dep).

## Steps
1. **Watcher pool** (`src/backend/features/explorer/watch.ts`): implement
   01's contract — the renderer sends its CURRENT expanded set
   (`explorer:watch { dirs }`, idempotent diff against the live pool); one
   `fs.watch(dir)` per dir, `unref`'d; pool capped at 64 with LRU
   eviction; evicted or refusing dirs (EMFILE, EPERM, network mounts)
   demote to the POLL SET — jittered ±25%, 2s base, re-entrancy-guarded,
   visibility-gated (the `mcp-status.ts` pattern). `rename` and `change`
   events are identical: mark the dir dirty.
2. **Coalescing**: per-dir dirty flags drain on a 150ms quiet-window timer
   into ONE `explorer:changed { dirs }` batch — the @parcel/watcher
   semantics ("a single notification … with all of the events at the
   end", RESEARCH §6) re-implemented. A `git checkout`-sized burst is a
   handful of batches, never a stream.
3. **Suspend rules**: window hidden (`hide`/`minimize` →
   `show`/`restore`, the mcp-status hooks) or explorer closed (renderer
   sends `{ dirs: [] }`) → every watcher closed, poll parked. On resume:
   one reconcile pass re-lists the expanded set. Assertable: a DEV
   counter (`window.__mogging.explorer.watchStats`) exposes live handle +
   poll counts.
4. **Renderer application** (`features/explorer/` + `file-tree.ts
   applyChanged`): re-list ONLY the batch's dirs; splice in place;
   expansion, selection, and scroll preserved; a dir deleted while
   expanded collapses into its parent's refreshed listing without a
   crash. Change-only: an identical listing → zero DOM work.
5. **TREELIVE smoke** (`MOGGING_TREELIVE`, fixture temp tree, real fs
   writes from the main process): (a) create/delete/rename in an expanded
   dir → the row lands ≤ 1s, selection + scroll intact; (b) writes into a
   COLLAPSED dir → zero `explorer:changed` traffic (spy) until it is
   expanded; (c) torrent: 500 files across 5 expanded dirs in one burst →
   ≤ 10 batches, 0 frames > 100ms while applying; (d) expand 100 dirs →
   handle count ≤ 64 (watchStats), and an EVICTED dir still updates via
   the poll when touched; (e) hidden window → zero events; re-show → one
   reconcile pass; (f) close the explorer → watchStats reports 0 handles,
   0 polls. Verdict `out/treelive-result.json`.

## Files
- `src/backend/features/explorer/watch.ts` · `src/main/explorer.ts`
  (watch/unwatch/changed wiring + visibility hooks) ·
  `src/ui/features/explorer/` · `components/file-tree.ts`
  (applyChanged) · `src/main/treelive-smoke.ts` · main dispatch ·
  qa-smokes.sh row

## Definition of Done
- The tree is ALIVE under an agent's writes and INERT the moment it is
  not on screen; every claim above is a smoke assertion, not a comment.
- TREELIVE green; the count grows by one; both budgets re-measured and
  unchanged.

## Checks that must be green
- typecheck 0; build ok; static gates; full local sweep; MILESTONE +
  PERCEPTION re-run (staying inside them is this step's whole point).

## Guardrails
- NEVER a recursive watcher; NEVER a watcher on a collapsed dir; no
  chokidar/parcel/watcher dependency — `fs.watch` + the house poll only.
- The daemon untouched; zero new wire surface (protocol stays v5).
- Batches carry dir paths only — no file contents; nothing in telemetry.
