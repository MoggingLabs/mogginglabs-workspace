# 16 — Files: the sidebar that watches your agents work

Sixteen agents can be writing into a workspace at once. The app has always shown
their **output** — terminals, blocks, attention — and never their **footprint**.
The explorer is the footprint: a right-side sidebar with the workspace's folder
open in a virtualized, git-decorated tree that updates live as agents write.

> **The custody stance, and everything else follows from it.** The explorer is a
> **window, not a manager** — [ADR 0010](adr/0010-explorer-window-not-manager.md).
> v1 is read-only: browse, open, reveal, copy, send-to-pane. Opening delegates to
> the OS and to the user's own tools ([ADR 0002](adr/0002-never-broker-provider-auth.md)'s
> neutrality, extended to files): we organize their view of the files; we never
> replace their editor. Nothing is indexed, nothing is walked recursively, names
> are read one level at a time on demand, and paths never enter telemetry
> ([ADR 0005](adr/0005-observability-sentry-posthog.md)).

Sourced design lineage: `prompts/phase-11/RESEARCH.md` (BridgeSpace's competitor
surface, VS Code's virtualized-list-wearing-a-tree and decoration split, the
tmux-sidebar virtues, the orchestrators' changed-files convergence).

---

## 1. What it is

`Ctrl+Shift+E`, or the **far-right** titlebar button (`panel-right`, mirroring the
rail's `panel-left` at the far left — the two toggles bookend the bar, each over
the column it opens). The dock is the outermost right column:

```
#rail | #content (the grid) | .browser-dock | .explorer-dock
```

Width 300px by default, dragged anywhere in `[240px, min(40vw, room)]` — where
`room` is whatever is left after the panes keep their **480px floor**. A greedy
drag can never squeeze the terminals out; the grid is what this app is for.
Open-state, width, and show-hidden persist in the app KV (`explorer.open`,
`explorer.width`, `explorer.showHidden`) and are read **once before first paint**,
so an explorer left open never flashes shut on boot.

**It never steals focus.** Opening, closing, re-rooting, refreshing, and live
updates all leave the caret exactly where it was. A keystroke meant for an agent
must never land in a tree (tmux-sidebar's virtue; the smoke asserts it).

---

## 2. The tree

ONE virtualized flat list wearing tree semantics — the VS Code shape
(RESEARCH §2), re-implemented clean-room in vanilla TS on the Phase-5 tokens.
**Zero new runtime dependencies**: no tree library, no watcher library, no icon
pack (VS Code's icon art is licensed third-party content, not ours to lift —
house glyphs live in `icons.ts`).

- **Rows are 28px**, absolutely positioned over a full-height spacer. Only a
  window of *viewport ± 8 overscan* rows is ever in the DOM. Measured: a
  **10,011-row** tree scrolled end-to-end held **32 DOM rows** at its peak, with
  **zero frames over 100ms**.
- **Because rows virtualize, tree ARIA is mandatory, not decorative**:
  `role=tree` / `treeitem`, `aria-expanded` on directories, and
  `aria-level` / `aria-setsize` / `aria-posinset` on every row — the APG requires
  these precisely when the full set is *not* in the DOM. Roving tabindex: exactly
  one row is tabbable.
- **Listings are lazy.** A directory is read the first time it is expanded, never
  before. Dirs first, then files, case-insensitive within each group. Capped at
  `EXPLORER_LIST_CAP = 1000` with a "capped" tail row — sorted, *then* capped, so
  truncation is deterministic.
- **Filenames are untrusted content**: `textContent` only, everywhere. A file
  called `<img src=x onerror=…>.md` renders as text and injects nothing.
- **Refusals are states, not crashes.** A denied, missing, or not-a-directory
  path becomes an inline dimmed row. The tree never throws.

### The keyboard map (APG, verbatim)

| Key | What it does |
|---|---|
| `↓` / `↑` | Move |
| `→` | Open a closed directory; on an open one, move to its first child |
| `←` | Close an open directory; on a closed one, move to its parent |
| `Home` / `End` | First / last row |
| `PgUp` / `PgDn` | One viewport |
| `Enter` / double-click | **File**: open it with the OS. **Directory**: toggle (the APG default action) |
| Type a letter | Type-ahead within the visible rows; `Esc` clears the buffer |
| `Shift+F10` / `ContextMenu` | The row's context menu, anchored to the row |
| `Ctrl+C` | Copy the selected path |
| `Ctrl+Shift+E` | Toggle the whole dock |

---

## 3. The liveness law: watch what's visible, nothing else

An agent writing into an **expanded** directory shows up within a second as ONE
coalesced update. Everything else — collapsed directories, a hidden window, a
closed explorer — costs **exactly zero**. No watcher library: per-directory
non-recursive `fs.watch` (a node built-in) is the whole trick, with a jittered
poll as the fallback tier. This is the VS Code watcher architecture (RESEARCH
§2/§6) minus the native dependency, and it uses only their non-recursive and
polling tiers — because we only ever watch what is on screen.

**A recursive watcher is forbidden outright** (ADR 0010). It would index a tree we
deliberately never index — the `node_modules` trap that `docs/05` already rejected.

### The three rules that make it cheap

1. **The renderer declares its WHOLE expanded set, every time.** `explorer:watch`
   carries `{ dirs }` — the root plus every expanded directory, priority-ordered
   (the root leads). Main diffs it against the live pool. There is deliberately
   **no incremental add verb**, so a leaked watcher has nowhere to hide.

2. **A batch means the LISTING moved.** An event only marks a directory dirty; the
   flush then re-reads its children and emits **only if the kinds+names actually
   changed**. This is what makes the law true on Windows: writing a file inside a
   *collapsed* subdirectory bumps that subdirectory's last-write time, which fires
   the **parent's** non-recursive watcher — a real OS event about a directory whose
   listing did not move. Without this check the renderer would be woken for
   nothing, and "a collapsed directory costs zero" would be a comment rather than
   a fact. **Measured: 20 writes into a collapsed directory produce 0 batches.**

3. **Two tiers, one signature.** Handles are capped at **64** (LRU by touch
   recency; a directory that has been firing outranks one that never has).
   Everything above the cap — and everything that *refuses* a handle (EMFILE,
   EPERM, an SMB mount) — demotes to a jittered **2s ± 25%** poll. The poll's
   trigger is the directory's own `mtime`: O(1), and it moves on
   create/delete/rename but **not** on a file's content edit, which is exactly the
   set of changes a name-listing tree cares about.

**Coalescing**: a 150ms quiet window, with a 600ms ceiling so a sustained torrent
cannot starve the flush. **Measured: 500 files across 5 directories → 1 batch,
0 frames over 100ms.** A `git checkout`-sized burst is a handful of batches, never
a stream.

**Suspend rules**: a hidden or minimized window closes every handle and parks the
poll; showing it again costs ONE reconcile pass over the visible set. A closed
explorer sends `{ dirs: [] }` and the pool goes to nothing. `explorer:stats`
exposes the live counts (`handles`, `polls`, `suspended`) so all of this is
*assertable* rather than merely claimed.

---

## 4. The decorations: what did my agents touch

**Not one new poller.** `git/probe.ts` has always run `status --porcelain=v2`
every 2.5s per tracked repo — and then thrown the file lines away after setting
`dirty`. Phase 11 parses the lines it was already paying for, from the same
output of the same spawn. The monitor's per-tick cache is keyed by **repo root**,
so a registered explorer root that any pane already tracks costs nothing extra
(and two panes in different subdirectories of one repo now cost one spawn instead
of two).

Emission is **change-only**: an idle repo — polled every 2.5s, like always —
sends nothing at all. **Measured: 0 `git:filesChange` messages across two-plus
full ticks on an untouched repo.**

### The split (VS Code's `FileDecoration.propagate`, RESEARCH §2)

A **file** wears the letter *and* the colour. A **folder** wears only the colour
its descendants propagated up to it — never a letter.

| State | Letter | Ink | Notes |
|---|---|---|---|
| modified | `M` | `--warning` | |
| added | `A` | `--success` | staged |
| untracked | `U` | `--success` | told apart from `A` by the letter |
| deleted | `D` | `--danger-ink` | name struck through |
| conflicted | `C` | `--danger-ink` | name heavier |
| renamed | `M` | `--warning` | a rename is a modification you can see the shape of |
| ignored | — | `--text-lo` | dimmed, **never hidden** — still a real file you may need |

**Why `--danger-ink` and not `--danger`.** The token block says plainly that
`--danger` is a *fill* and "anything rendering danger as words takes
`--danger-ink`" — it measures 2.93:1 on nord's elevated surface. Deleted and
conflicted are *words* here, so both take `--danger-ink` and are told apart by
**form** instead. On a **selected** row the inks are mixed toward `--text-hi`,
which strengthens them in both directions — lighter on dark themes, darker on
light — because the selection wash (`--accent-weak`) lifts the background enough
to push several inks into the 4.1–4.4 band. All of it is *measured*, in four
themes, on plain / hover / selected fills, by the TREEGIT gate.

A folder inherits the **loudest** thing beneath it (conflicted > deleted >
modified > added > untracked): a conflict must not hide behind an untracked
sibling.

**Ignored** files are dimmed by asking git, never by parsing `.gitignore`
ourselves — git owns that grammar (negations, precedence, nested files), and a
hand-rolled matcher is wrong in exactly the cases users notice. One
`git check-ignore --stdin` batch per expanded directory, cached until that
directory's listing changes. **Measured: 1 spawn per directory, and 0 on a
re-ask.** This is the pack's only new `git` process; it is never polled.

**Dormancy**: a workspace that is not in a repo registers nothing, is never
probed, and **never spawns git at all** — `findRepoRoot` is a pure filesystem
walk. No Changes chip either: a lens over nothing would be a lie.

### The Changes lens

The changed-files view every orchestrator converged on (RESEARCH §5 — Nimbalyst,
Manaflow) — except ours is the **same tree, filtered**, so you never lose the
shape of the project. A header chip carries a live count (equal to porcelain's);
clicking it filters the tree to the changed paths and their ancestor directories,
auto-expanded. Clicking again — or `Esc` with focus in the dock — restores the
prior expansion **exactly**.

---

## 5. The actions: delegate, copy, type. Never execute.

> **We type; the user executes.** Nothing in the explorer writes, renames, moves,
> or deletes a file, and nothing ever presses Enter in a pane. An agent pane's
> stdin belongs to the user.

Right-click, `Shift+F10`, or the `ContextMenu` key opens the house context menu
(`components/context-menu.ts` — a **generic** primitive: the explorer is its first
customer, not its owner):

- **Open** — `shell.openPath`. The OS decides what opens it. That is the point.
- **Reveal in File Explorer / Finder / file manager** — `shell.showItemInFolder`,
  labelled per-OS.
- **Copy path** (`Ctrl+C`) and **Copy relative path**.
- **Send to pane** — types the path at the focused pane's cursor.

Every path-taking verb passes a guard in main: absolute, existing, and **inside
the folder the explorer is showing**. Anything else is a typed refusal
(`invalid` · `outside-root` · `missing` · `denied`) rendered as a toast — never a
dialog, never a crash. A **closed dock has no root, and therefore no actions**.

**Send-to-pane** inserts the path *relative to the focused pane's own cwd* when
the file sits under it (that is what a person types), absolute otherwise — a
relative path that escapes the cwd would be a lie. It is quoted by the shared
`quotePathForShell`, which also strips control characters: **a filename cannot
smuggle a newline, and therefore cannot press Enter.** The `pane-input-port` is
the door, and it has no `run`, no `submit`, and no way to append a carriage
return — the absence of the verb *is* the guarantee.

**Drag** a row: `text/plain` carries the quoted insert, `text/uri-list` the plain
`file://` path for OS targets, and a private `application/x-mogging-path` marker
gates the pane's drop handler — so dragging arbitrary selected text out of
another app still cannot type itself into your terminal.

**Proven inert.** After typing eight hostile filenames into a live shell —
including `$(rm -rf).txt`, `&echo pwned&.txt`, `%USERPROFILE%.txt` — the pane
still shows **one prompt**. Not two. Nothing echoed; all eight files survived.

---

## 6. Per-OS notes

- **Windows drive roots.** `FS_DRIVE_ROOT` (the empty string) is the virtual
  parent of `C:\`, and its listing is the drive letters. On POSIX the parent of
  `/` is `null`, because `/` really is the top. The renderer joins nothing and
  splits nothing: every entry arrives carrying its own absolute path.
- **Hidden files** are the **dot rule on every platform**. Windows' HIDDEN
  attribute is not readable from `fs.Dirent`, so a dotfile is what "hidden" means
  here — and the UI says so.
- **Reveal** is labelled *File Explorer* on Windows, *Finder* on macOS, and
  *Show in file manager* elsewhere.
- **Quoting** follows the pane's shell: POSIX single-quotes (an embedded `'`
  closes, escapes, reopens), PowerShell single-quotes (an embedded `'` doubles),
  and `cmd` double-quotes (`"` is an illegal Windows filename character anyway).
  A **remote** pane's shell lives on the ssh host, so its paths quote POSIX.
- **The Windows parent-watcher bubble** (§3, rule 2) is the one platform quirk
  that shapes the architecture rather than merely annoying it.

---

## 7. Measured

All numbers from the gates, on the composed surface (16 panes + the explorer open
+ a write torrent). Budgets are `docs/05` and `docs/07`, **unchanged by this pack**.

| What | Budget | Gate |
|---|---|---|
| 10k-row tree, scrolled end-to-end | DOM rows bounded; 0 frames > 100ms | FILETREE |
| An agent's write → on screen | ≤ 1s | TREELIVE · FILESMILESTONE |
| 500 files / 5 dirs → batches | ≤ 10 | TREELIVE |
| Writes into a collapsed dir | 0 batches | TREELIVE |
| Watcher handles at 100 expanded dirs | ≤ 64 (rest poll) | TREELIVE |
| Hidden window / closed explorer | 0 handles, 0 polls, 0 git traffic | TREELIVE · FILESMILESTONE |
| Workspace switch, explorer open | ≤ 100ms | EXPLORER · FILESMILESTONE |
| 16 panes + explorer + torrent | gap ≤ 150ms · fps ≥ 30 · heap ≤ 300MB | FILESMILESTONE |
| Badge inks, 4 themes × 3 fills | ≥ 4.5:1 (AA) | TREEGIT |
| Menu inks, 4 themes | ≥ 4.5:1 (AA) | FILEACT |

Seven gates: **FSLIST · FILETREE · EXPLORER · TREELIVE · TREEGIT · FILEACT ·
FILESMILESTONE**. FILESMILESTONE is the only authority on "Phase 11 done".

---

## 8. The demo (a fresh machine, the app, and `mogging`)

Nothing below needs a vendor CLI, a network, or a key.

```bash
# 1. A repo with something to change.
mkdir demo && cd demo && git init && mkdir src docs
printf 'export const v = 1\n' > src/index.ts
printf '# guide\n' > docs/guide.md
git add -A && git commit -m baseline

# 2. Open it as a workspace. (Or: New workspace → pick the folder.)
mogging .
```

In the app:

1. Press **`Ctrl+Shift+E`**, or click the **far-right** titlebar button. The tree
   opens on `demo/`.
2. Expand `src/`. Now, **in one of the panes**, act like an agent:

   ```bash
   printf 'export const v = 2\n' > src/index.ts   # M appears on index.ts, within a second
   printf 'export const n = 1\n' > src/new.ts     # U appears on new.ts
   ```

   `src/` tints — the folder takes the colour, never the letter. The **Changes**
   chip counts 2.
3. Click **Changes**. The tree filters to exactly those two files, ancestors
   expanded. Click it again (or press `Esc`): your expansion comes back exactly
   as it was.
4. Right-click `index.ts` → **Send to pane**. The quoted path appears at the
   pane's cursor. **Nothing runs** — press Enter yourself, or don't.
5. Collapse `src/`, then write another file into it from the pane. **Nothing
   happens**, because nothing is watching it. Expand it again: there it is.
6. Close the explorer. It now costs zero — no watchers, no polls, no git traffic
   beyond what shipped before this pack.

---

## 9. Deferred (recorded, not refused — ADR 0010)

Each behind its own future ADR, the day the watching job proves insufficient:

- **Write verbs**: create / rename / delete / move.
- **An in-app editor** (or any file-content viewer that would grow into one).
- **Compact folder chains** (`a/b/c` single-child rendering): it complicates every
  keyboard, ARIA, and decoration path for a payoff our shallow-to-medium
  workspace trees rarely see (RESEARCH §2).
