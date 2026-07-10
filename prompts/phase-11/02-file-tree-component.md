The tree itself (Phase-11/02): ONE virtualized flat list wearing tree
semantics — the VS Code shape (RESEARCH §2), clean-room in vanilla TS on
the Phase-5 tokens. It must swallow a 10k-entry directory, read beautifully
in both themes, and drive fully from the keyboard. Channel-free like
`folder-browser.ts`: the caller injects `explorer:list`.

## Steps
1. **Model** (`src/ui/components/file-tree.ts`): an expansion-map over
   lazy nodes, flattened to a VISIBLE-ROWS array on every mutation. Rows
   carry `{ entry, level, expanded?, loading?, refusal?, truncated? }`.
   Children resolve on first expand via the injected `list(path,
   showHidden)` — loading row while pending, spliced on arrival; a
   refusal becomes an inline dimmed row, never a crash. Change-only: an
   identical listing (name+kind sequence) → zero DOM work.
2. **Virtualization**: fixed 28px rows (the house hitbox floor), an
   absolutely-positioned window of viewport ± overscan rows over a
   full-height spacer, rAF-batched scroll; DOM row count bounded
   regardless of tree size. Because rows virtualize, tree ARIA is
   mandatory (RESEARCH §6): `role=tree`, rows `role=treeitem` with
   `aria-expanded` (dirs), `aria-level`, `aria-setsize`, `aria-posinset`;
   roving tabindex (one `0`, rest `-1`).
3. **Keyboard — APG verbatim**: ↓/↑ move; → opens a closed dir, else →
   first child; ← closes an open dir, else → parent; Home/End; PgUp/PgDn;
   Enter/dbl-click activates (`onActivate(entry)`); type-ahead within
   visible rows (folder-browser precedent), Esc clears.
4. **Visuals (pretty is a requirement)**: indent guides — 1px `--border`
   verticals per level, the focused row's chain at `--border-strong` (the
   v1.36 pattern); `folder`/`folder-open` + a NEW `file` glyph in
   `icons.ts` (house-drawn, no icon pack); repo pill on `isRepo` dirs;
   chevron rotates over `--dur-1`; hover/selection fills from tokens;
   truncated tail row ("+N more — capped"); empty dir → house
   `EmptyState`. Filenames are untrusted: `textContent` only. Both
   themes; AA on row inks over hover/selection fills.
5. **API**: `createFileTree(opts) -> { el, setRoot(path), reveal(path),
   applyChanged(dirs)` (04 consumes)`, expandedDirs(), setExpanded(dirs),
   setShowHidden(v), focusList() }`; `FileTreeOpts { list, onActivate?,
   onSelect?, onExpandedChange?, showHidden? }`.
6. **Dev harness + FILETREE smoke** (`MOGGING_FILETREE`, dispatch,
   qa-smokes row): a DEV-only `window.__mogging.filetree.mount(root)`
   mounts one standalone into `#content`. Fixture tree incl. one 10k-file
   dir and a denied dir — (a) scroll the 10k dir end-to-end: DOM rows ≤
   viewport + 2×overscan at every sample, 0 frames > 100ms; (b) lazy: no
   `list` call for a dir until first expand (spy); (c) full APG walk
   mouse-free, roving tabindex correct; (d) aria-level/setsize/posinset
   correct on a 5-deep chain; (e) type-ahead jumps; (f) the denied dir
   renders a refusal row, no crash; (g) a hostile filename renders as
   text — no element injected. Verdict `out/filetree-result.json`.

## Files
- `src/ui/components/file-tree.ts` · `components/index.ts` ·
  `components/icons.ts` (file glyph) · global.css (tree block, tokens
  only) · `src/main/filetree-smoke.ts` · main dispatch · qa-smokes.sh row

## Definition of Done
- 10k entries scroll at budget with a bounded DOM; the whole tree drives
  mouse-free; a screen reader sees a correct virtualized tree.
- FILETREE green; the count grows by one; FOLDERPICK/WIZARDUX untouched.

## Checks that must be green
- typecheck 0; build ok; static gates; full local sweep; PERCEPTION +
  MILESTONE re-run (renderer touched).

## Guardrails
- The component stays channel-free (ADR 0004) — IPC is injected, like
  `folder-browser.ts`.
- No innerHTML anywhere near a filename; tokens only; no new deps.
- No dock, no toggle, no persistence yet — that is 03.
