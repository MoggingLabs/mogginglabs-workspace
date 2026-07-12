// The file explorer's read surface (Phase-11/01, ADR 0010: a window, not a
// manager). Files AND dirs, one level, on demand, typed refusals — and nothing
// else: no write verb exists on these channels to typecheck against, nothing is
// walked recursively or indexed, and no path ever reaches telemetry (ADR 0005).
//
// `fs:listDir` (fs.ipc.ts) stays dirs-only BY CONTRACT — it picks a working
// folder. The explorer needs the files too, so it gets its own verbs rather
// than a flag that would quietly widen the wizard's browser.
//
// The path math stays in the main process for the same reason as fs.ipc.ts:
// `@ui` joins nothing and splits nothing (ADR 0004), and Windows drive roots
// ride the same `FS_DRIVE_ROOT` virtual parent.

export interface ExplorerEntry {
  /** Display name — a file or folder name, or `C:` at the drive list. */
  name: string
  /** Absolute path of this child. The renderer navigates by this, never by joining. */
  path: string
  /** A directory (expandable) or a file (a leaf). A symlink is classified by ONE
   *  stat of its target; a broken link is a leaf — listed, never a throw. */
  kind: 'dir' | 'file'
  /** Dirs only: a `.git` entry exists inside (dir OR file — worktrees use a file).
   *  No git spawn. Absent on files. */
  isRepo?: boolean
}

export interface ExplorerListing {
  ok: true
  /** Canonical absolute path of the listed directory (`FS_DRIVE_ROOT` at the drive list). */
  path: string
  /** Parent directory, or null when there is nowhere further up. */
  parent: string | null
  /** Dirs first, then files; case-insensitive within each group. */
  entries: ExplorerEntry[]
  /** True when the directory held more than `EXPLORER_LIST_CAP` children. */
  truncated: boolean
}

/**
 * A refusal, not an exception — the fs.ipc.ts posture. The handler never
 * throws: an unreadable folder is an ordinary thing to expand, and the tree
 * has to render it as a state.
 *  - `denied`          EACCES / EPERM — the OS said no.
 *  - `missing`         ENOENT — gone, or never there.
 *  - `not-a-directory` ENOTDIR — a file path.
 *  - `invalid`         not an absolute path, or junk shape (we never resolve against a cwd).
 */
export interface ExplorerRefusal {
  ok: false
  reason: 'denied' | 'missing' | 'not-a-directory' | 'invalid'
  path: string
}

export type ExplorerResult = ExplorerListing | ExplorerRefusal

export interface ExplorerListRequest {
  /** Absolute. `FS_DRIVE_ROOT` asks for the Windows drive list. */
  path: string
  /** Dot-rule on every platform, files and dirs alike — the fs.ipc.ts rationale
   *  (Windows' HIDDEN attribute is not readable from `fs.Dirent`). */
  showHidden?: boolean
}

/** Sorted (dirs first, case-insensitive), THEN capped, THEN repo-probed — so
 *  truncation is deterministic and a 10k-entry folder costs 1000 probes, not 10k. */
export const EXPLORER_LIST_CAP = 1000

// ── Liveness verbs (ADR 0010.d — CONTRACT ONLY in 11/01; 11/04 implements). ──
// Watch what's visible, nothing else: the renderer declares its whole expanded
// set every time, main reconciles watchers against it. No incremental add verb
// exists, so a leaked watcher is structurally impossible to accumulate.

export interface ExplorerWatchRequest {
  /** The CURRENT expanded set, absolute paths. Idempotent: same set, same watchers. */
  dirs: string[]
}

/** `explorer:changed` payload: directories whose listings went stale, coalesced —
 *  an agent's write burst arrives as ONE event, not one per file. */
export interface ExplorerChangedEvent {
  dirs: string[]
}

/** `explorer:stats` — the liveness law made ASSERTABLE (11/04). Counts and one boolean:
 *  a closed explorer, or a hidden window, must report zero of both. Never a path. */
export interface ExplorerWatchStats {
  handles: number
  polls: number
  suspended: boolean
}

// ── Delegation verbs (Phase-11/06) ───────────────────────────────────────────
// The app's FIRST file-path shell calls — and they are still not write verbs. `open` and
// `reveal` hand the path to the OS and to the user's own tools and step back (ADR 0010.b:
// we organize their view of the files; we never replace their editor). Nothing here
// creates, renames, moves, or deletes anything, and nothing here executes.

/**
 *  - `invalid`      not a string, or not an absolute path.
 *  - `outside-root` not inside the folder the explorer is SHOWING. A closed dock has no
 *                   root, so it has no actions — the guard is the boundary, not a hint.
 *  - `missing`      the path is not there (it vanished, or never existed).
 *  - `denied`       the OS refused to open it. Its business, reported honestly.
 */
export type ExplorerActionRefusal = 'invalid' | 'outside-root' | 'missing' | 'denied'

/** `ok: true` means DISPATCHED — what opens, and whether anything opens at all, is the
 *  user's machine's business. We never claim to know what their `.ts` files open in. */
export interface ExplorerActionResult {
  ok: boolean
  reason?: ExplorerActionRefusal
}

/**
 * The dataTransfer type that marks a drag as OURS (11/06). A pane accepts a text drop only
 * when it sees this: dragging arbitrary selected text out of another app must never type
 * itself into a terminal. The payload rides `text/plain` (the quoted insert), so an editor
 * or an OS target gets something sensible too.
 */
export const EXPLORER_DRAG_TYPE = 'application/x-mogging-path'

// ── Dock chrome state (11/03) ────────────────────────────────────────────────
// Persisted in the app's KV, read ONCE before the dock first paints so an open
// explorer never flashes shut on boot. The `browser:init` precedent.

export interface ExplorerDockInit {
  open: boolean
  width: number
  showHidden: boolean
}

/** Default dock width, and the clamp the renderer enforces on every drag.
 *  `EXPLORER_MIN_CONTENT` is the grid's floor: with BOTH docks open, the panes
 *  keep this much room, so a dragged explorer can never squeeze the terminals out. */
export const EXPLORER_DOCK_WIDTH = 300
export const EXPLORER_MIN_WIDTH = 240
export const EXPLORER_MIN_CONTENT = 480
