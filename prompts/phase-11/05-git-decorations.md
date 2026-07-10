The decorations (Phase-11/05): the explorer answers "what did my agents
touch" without ONE new poller. `git/probe.ts` already spawns `status
--porcelain=v2` every 2.5s per tracked cwd, then throws the file lines away
— parse what we already pay for, fan it out change-only, and paint VS
Code's split: letter + color on files, color only on ancestor folders (the
`propagate` semantics, RESEARCH §2). Plus the lens every rival converged
on: Changes.

## Steps
1. **Richer parse, same spawn** (`src/backend/features/git/probe.ts`):
   behind an opt-in flag, retain per-file records — `GitFileState { path`
   (repo-relative)`, state: modified|added|untracked|deleted|conflicted|
   renamed }`, capped 2000 + `truncated`. `GitMonitor`
   keeps its shared 2.5s tick, per-cwd dedupe, and change-only discipline
   — the file list rides the same compare, emitted only on real change,
   only for roots the explorer REGISTERED. Contracts in `git.ipc.ts` +
   channels: `git:filesQuery`, `git:filesWatch/Unwatch`,
   `git:filesChange`, riding the monitor's existing cwd registry.
2. **Badges** (`features/explorer/` + a `file-tree.ts` hook):
   letters M/A/U/D/C (R renders as M) at `--fs-10`, inks from the
   semantic tokens — modified `--warning`, added + untracked `--success`,
   deleted `--danger`, conflicted `--danger-ink` — filename ink to match.
   FOLDERS get color only, no letter, computed over VISIBLE rows once
   per batch; repo-relative → absolute joins renderer-side.
3. **Ignored dimming**: per EXPANDED dir, one `git check-ignore --stdin`
   batch of that dir's entries (probe spawn discipline), cached,
   invalidated by 04's `explorer:changed` batches; ignored rows dim to
   `--text-lo` (still navigable). We never parse .gitignore ourselves
   (RESEARCH §2).
4. **The Changes lens**: a header chip ("Changes" + `CountBadge` of the
   status list) filters the SAME tree to decorated paths, ancestors
   auto-expanded — the changed-files view rivals ship (RESEARCH §5);
   toggling back (or Esc) restores prior expansion exactly.
5. **Dormancy**: a non-repo workspace (`findRepoRoot` → null) or a
   closed explorer → zero `git:files*` traffic, zero check-ignore
   spawns; the pane-chip path (`git:change`) stays byte-identical.
6. **TREEGIT smoke** (`MOGGING_TREEGIT`, fixture repo via the gallery's
   `makeRepo()`): stage/modify/delete/untrack/conflict/ignore fixtures —
   (a) correct letter + ink per state, AA-measured across themes on
   plain/hover/selected fills (`aa-probe.ts`); (b) folder color
   propagation on visible ancestors, letterless; (c) touch a file → the
   badge flips next tick; an untouched repo → zero `git:filesChange`
   messages (spy); (d) the lens shows exactly the status list, count
   matches porcelain, exit restores expansion; (e) ignored dim costs ≤ 1
   check-ignore spawn per dir per invalidation (spy); (f) non-repo cwd →
   zero git traffic; (g) the per-pane git chip gates green unmodified.
   Verdict `out/treegit-result.json`.

## Files
- `src/backend/features/git/{probe,monitor}.ts` · `git.ipc.ts` ·
  `channels.ts` · `src/main/git.ts` · `src/ui/features/explorer/` ·
  `components/file-tree.ts` · global.css · `src/main/treegit-smoke.ts` ·
  dispatch · qa-smokes row · gallery (badged tree + lens, both themes)

## Definition of Done
- A dirty repo reads at a glance: letters on files, tinted folders,
  dimmed ignored, a live Changes count; ZERO git processes added by
  this pack.
- TREEGIT green; the sweep count grows by one; budgets unchanged.

## Checks that must be green
- typecheck 0; build ok; static gates; full local sweep; MILESTONE +
  PERCEPTION re-run.

## Guardrails
- The 2.5s shared tick is sacred — no second cadence, no per-file
  pollers; caps + `truncated` flags on every list.
- Repo-relative paths cross IPC; no libgit/isomorphic-git dependency.
- Decorations are paint: never reordering, hiding (lens aside), or
  mutating entries.
