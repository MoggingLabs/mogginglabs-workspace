Actions (Phase-11/06): everything a READ-ONLY explorer may do with a file —
open it with the OS, reveal it, copy its path, hand it to an agent pane —
plus the house context menu those verbs live in. The custody line (ADR
0010): we type, the USER executes; nothing here writes, renames, or
deletes, and nothing ever presses Enter in a pane.

## Steps
1. **Delegation verbs** (`explorer.ipc.ts` + `src/main/explorer.ts`):
   `explorer:open (path)` → `shell.openPath`; `explorer:reveal (path)` →
   `shell.showItemInFolder` — the FIRST file-path shell calls in the app,
   so the seam is injectable: `registerExplorer({ shellPort })` defaults
   to Electron's shell, smokes inject a recording spy (the FAKE-parts
   rule). Main validates: absolute, exists, and INSIDE the explorer's
   current root — anything else is a typed refusal `{ ok: false,
   reason }`; `{ ok: true }` on dispatch.
2. **The context menu** (`src/ui/components/context-menu.ts`, GENERIC —
   a house primitive, feature-free): token-styled popup, `role=menu` /
   `menuitem`, arrow + Home/End roving focus, Esc/blur/outside-click
   dismiss with focus returned to the invoking element, viewport-clamped
   position, separators + disabled items. Gallery part (both themes).
3. **Row wiring** (`features/explorer/`): right-click / Shift+F10 /
   ContextMenu key → Open · Reveal in Explorer/Finder (per-OS label) ·
   Copy path · Copy relative path · Send to pane. Enter/dbl-click on a
   file = Open (dirs keep toggling); Ctrl+C = copy path (Electron
   clipboard).
4. **Send to pane + drag**: the path — RELATIVE to the focused pane's cwd
   when it sits under it, else absolute — quoted per-OS (POSIX
   single-quote escaping; Windows double-quotes), written to the FOCUSED
   pane through the existing terminal input seam, NEVER Enter-terminated:
   typed, not executed. Rows are `draggable`; dropping on a pane inserts
   the same quoted text (`text/plain` dataTransfer, one drop handler on
   the pane container); dragging out to OS targets carries the plain
   path.
5. **FILEACT smoke** (`MOGGING_FILEACT`, fixture tree + a shell-provider
   pane): (a) Open/Reveal land the exact absolute path in the spy;
   outside-root and vanished paths refuse typed — no dialog, no crash;
   (b) copy path / relative path → clipboard asserted; (c) send-to-pane:
   the pane buffer tail equals the quoted path with NO trailing newline;
   (d) hostile names — `$(rm -rf).txt`, `; echo pwned;`, spaces, unicode,
   `<img onerror=x>.md` — arrive as ONE inert quoted arg and render as
   text everywhere; (e) menu: opens on Shift+F10, full keyboard walk, Esc
   returns focus to the row, every item ≥ 28px; (f) the drag payload
   `text/plain` equals the quoted insert. AA on menu inks, both themes.
   Verdict `out/fileact-result.json`.

## Files
- `src/contracts/ipc/explorer.ipc.ts` · `contracts/ipc/channels.ts` ·
  `src/main/explorer.ts` (shellPort seam) ·
  `src/ui/components/context-menu.ts` · `components/index.ts` ·
  `src/ui/features/explorer/` · global.css (menu block) ·
  `src/main/fileact-smoke.ts` · dispatch · qa-smokes.sh row · gallery

## Definition of Done
- A file is open-able, reveal-able, copy-able, and hand-able to an agent
  without the explorer ever executing anything; hostile filenames are
  provably inert end-to-end.
- The context menu is a reusable house primitive with its own gallery
  states.
- FILEACT green; the count grows by one.

## Checks that must be green
- typecheck 0; build ok; static gates; full local sweep; PERCEPTION +
  MILESTONE re-run.

## Guardrails
- No execute verb of ANY kind; no Enter into a pane — an agent pane's
  stdin belongs to the user (the possession discipline, applied to
  files).
- Smokes never call the real shell — the injected spy is the only
  witness.
- Quoting is per-OS and hostile-tested; the menu component ships
  feature-free (no explorer imports).
