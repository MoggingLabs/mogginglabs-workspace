The visual folder browser (Phase-8.5/03). Today the wizard's "Where" is a
typed path bar that understands `cd`-style input plus a native Browse
button — fine for terminal people, hostile to everyone else. This step
adds a REAL in-app directory browser: click through folders, see where you
are on a breadcrumb, pick with one click. The typed bar stays (it's fast)
— the browser and the bar are two views of the same selection.

## Steps
1. **The listing channel** (`src/main/` + `@contracts/ipc`): a read-only
   `fs:listDir` handler — given an absolute path, return `{ path, parent,
   entries: [{name, isRepo}] }` for DIRECTORIES only (files never listed),
   dotfolders filtered by default with a "show hidden" toggle flag,
   `isRepo` = a cheap `.git` existence probe (no git spawn). Sorted
   case-insensitively. Errors (permission, vanished) return a typed
   refusal, never throw. Cap 500 entries + a `truncated` flag. Windows
   drive roots: listing the virtual parent of `C:\` returns the drive list
   (the 6/03 lesson: canonical path handling per-OS, tested on win32).
2. **The component** (`src/ui/components/folder-browser.ts`): a bordered,
   token-padded panel — breadcrumb row on top (each segment clickable;
   the CURRENT folder is the selection, shown bold with a subtle
   "selected" fill), scrollable dir list below (folder icon · name · repo
   pill when `isRepo`), double-click or Enter descends, Backspace/`..` row
   ascends, type-to-filter within the visible list. Keyboard: full arrows
   + Home/End; roving tabindex; `aria-` roles for a listbox. Empty dir →
   the house `EmptyState`. Hidden-folder toggle in the panel footer.
3. **Wizard integration** (`src/ui/features/wizard/index.ts`): the Where
   card hosts the browser UNDER the existing path bar; the two stay in
   lockstep — typing/`cd` in the bar navigates the browser, clicking in
   the browser updates the bar + the small current-folder line above it,
   and the git probe + repo tools row keep keying off the shared `cwd`.
   Recents become one-click jumps that also drive the browser. Native
   Browse remains as the escape hatch.
4. **Scope honesty**: the browser reads directory NAMES only — nothing is
   indexed, watched, or sent anywhere (ADR 0005: no paths in telemetry).
   State it in the panel's caption.
5. **FOLDERPICK smoke** (`MOGGING_FOLDERPICK`, env-gated, qa-smokes.sh):
   fixture tree in a temp dir (nested dirs, one with `.git`, one hidden,
   600 siblings for the cap) — (a) listing returns dirs only, sorted,
   hidden filtered, `truncated` set; (b) the repo pill renders for the
   `.git` dir; (c) click-descend + breadcrumb-ascend update the wizard's
   `cwd` AND the path bar text; (d) typing a path in the bar re-roots the
   browser; (e) keyboard: arrows + Enter descend without a mouse; (f) a
   permission-denied path shows the refusal state, no crash; (g) hidden
   toggle reveals the dotfolder. Verdict `out/folderpick-result.json`.

## Files
- `contracts/ipc/channels.ts` · `src/main/fs-browse.ts` (+ register) ·
  `components/folder-browser.ts` · `components/index.ts` ·
  `features/wizard/index.ts` · `src/main/folderpick-smoke.ts` ·
  qa-smokes.sh row · gallery (both themes)

## Definition of Done
- A folder anywhere on disk is reachable by clicks alone; the breadcrumb
  always shows where you are; bar and browser never disagree.
- Works on Windows drive roots and POSIX `/` (smoke covers the fixture;
  dev-verify both notations, recorded in the books).
- WIZARDUX + TEMPLATE gates still green; FOLDERPICK green; count bumped.

## Checks that must be green
- `npm run typecheck` → 0; build ok; boundaries clean.
- Full local sweep; PERCEPTION re-run (renderer touched).

## Guardrails
- Directories only, read-only, on demand — no recursive walks, no
  watchers, no background indexing.
- The typed bar is not deprecated; power users keep their path.
