The explorer starts at the CUSTODY STANCE, not the UI. Codify ADR 0010, cut
the contracts, and ship the read service every later step consumes — files +
dirs, one level, on demand, typed refusals — proven by a fixture smoke with
zero UI. `fs:listDir` (FOLDERPICK) is dirs-only BY CONTRACT ("Files are
never listed") and stays untouched; the explorer gets its own verbs.

## Steps
1. **ADR 0010 — the explorer is a window, not a manager** (`docs/adr/`):
   v1 is read-only (browse/open/reveal/copy/send-to-pane;
   create/rename/delete/move and an in-app editor are DEFERRED with
   rationale, not refused); opening delegates to the OS + the user's own
   tools (ADR 0002's neutrality extended to files); reads are one level,
   on demand — no recursive walk, no index; the liveness law (watch
   what's visible, nothing else — 04 implements); paths never in telemetry
   (ADR 0005); zero new runtime deps. One paragraph of research lineage
   (RESEARCH.md). Explicitly forbid: recursive watchers; any write verb
   on explorer channels; compact folder chains (deferred, RESEARCH §2).
2. **Contracts** (`src/contracts/ipc/explorer.ipc.ts` + `ExplorerChannels`
   in `channels.ts`, spread into `AllChannels`): `explorer:list ({ path,
   showHidden? }) -> ExplorerResult`; `explorer:watch/unwatch/changed`
   (04 implements; 01 only defines). Types mirror `fs.ipc.ts` with files
   added: `ExplorerEntry { name, path, kind: 'dir'|'file', isRepo? }` ·
   `ExplorerListing { ok: true, path, parent, entries, truncated }` ·
   `ExplorerRefusal { ok: false, reason: 'denied'|'missing'|
   'not-a-directory'|'invalid', path }` · `EXPLORER_LIST_CAP = 1000`
   (sort → cap → probe) · watch: `{ dirs }` (the CURRENT expanded set,
   idempotent) / changed: `{ dirs }` (coalesced). Closed unions, no
   `any`.
3. **Backend** (`src/backend/features/explorer/list.ts`, Electron-free):
   dirs first then files, case-insensitive; dot-rule hidden filter (the
   fs-browse rationale); `isRepo` = cheap `.git` existence probe, no git
   spawn; symlinks: one stat for kind, broken links listed as files,
   never throw; Windows drive roots via the `FS_DRIVE_ROOT` precedent.
   Share path canonicalization with fs-browse via an extracted helper —
   REFACTOR, not fork; `fs:listDir` byte-identical after.
4. **Main** (`src/main/explorer.ts`): `registerExplorer()` validates
   shape (junk → `invalid` refusal, never throw), binds `explorer:list`;
   register call in `src/main/index.ts`.
5. **FSLIST smoke** (`MOGGING_FSLIST`, dispatch branch, qa-smokes.sh
   row): fixture temp tree (nested dirs + files, dotfile + dotdir, a
   `.git` repo dir, a broken symlink, 1500 siblings, a denied dir) —
   (a) files AND dirs, dirs-first, case-insensitive; (b) hidden filtered
   by default, `showHidden` reveals; (c) cap + `truncated`; (d) typed
   refusals, all four reasons; (e) `isRepo` true exactly on the repo dir;
   (f) broken symlink listed, no throw; (g) FOLDERPICK still green.
   Verdict `out/fslist-result.json`.

## Files
- `docs/adr/0010-explorer-window-not-manager.md` ·
  `src/contracts/ipc/explorer.ipc.ts` · `contracts/ipc/channels.ts`
  (+AllChannels) · `src/backend/features/explorer/` · fs-browse helper
  extraction · `src/main/explorer.ts` · `src/main/index.ts` ·
  `src/main/fslist-smoke.ts` · qa-smokes.sh row

## Definition of Done
- FSLIST green; the sweep count grows by one in the books.
- The ADR states every stance above; the deferred list is recorded.
- No UI changed; FOLDERPICK and WIZARDUX green unmodified.

## Checks that must be green
- `npm run typecheck` → 0; build ok; static gates (AUDIT · SPACING ·
  PTYSEAM · PROTOVER); full local sweep including the new gate.

## Guardrails
- Read-only by construction: no write verb exists to typecheck against.
- The watch verbs are CONTRACT ONLY this step — no watcher code lands.
- Zero new deps; zero network; the daemon untouched (protocol stays v5).
