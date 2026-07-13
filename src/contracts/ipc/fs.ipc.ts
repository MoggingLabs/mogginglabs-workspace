// Read-only directory listing for the wizard's folder browser (Phase-8.5/03).
//
// SCOPE, and it is the whole contract: directory NAMES, on demand, one level.
// Nothing is indexed, watched, or walked recursively, and no path ever reaches
// telemetry (ADR 0005). Files are never listed — this picks a working folder.
//
// WHY THE MAIN PROCESS OWNS THE PATH MATH. `@ui` must not do per-OS path
// arithmetic (ADR 0004: it depends only on contracts). So a listing carries the
// absolute `path` of every child and a ready-made `crumbs` trail; the renderer
// joins nothing and splits nothing. That is also what makes Windows drive roots
// representable at all — see `FS_DRIVE_ROOT`.

/**
 * The virtual parent of a Windows drive root (`C:\`), whose listing is the drive
 * list. Produced ONLY on win32; on POSIX the parent of `/` is `null`, because `/`
 * really is the top. Never a real path, so it can never collide with one.
 */
export const FS_DRIVE_ROOT = ''

export interface DirEntry {
  /** Display name — a folder name, or `C:` at the drive root. */
  name: string
  /** Absolute path of this child. The renderer navigates by this, never by joining. */
  path: string
  /** A `.git` entry exists inside (dir OR file — worktrees use a file). No git spawn. */
  isRepo: boolean
}

/** One clickable breadcrumb segment. First is the root (`/`, `C:`, or "This PC"). */
export interface DirCrumb {
  label: string
  path: string
}

export interface DirListing {
  ok: true
  /** Canonical absolute path of the listed directory (`FS_DRIVE_ROOT` at the drive list). */
  path: string
  /** Parent directory, or null when there is nowhere further up. */
  parent: string | null
  crumbs: DirCrumb[]
  entries: DirEntry[]
  /** True when the directory held more than `FS_LIST_CAP` subdirectories. */
  truncated: boolean
}

/**
 * A refusal, not an exception. The handler never throws: an unreadable folder is
 * an ordinary thing to click on, and the browser has to render it as a state.
 *  - `denied`       EACCES / EPERM — the OS said no.
 *  - `missing`      ENOENT — typed a path that isn't there, or it vanished mid-browse.
 *  - `not-a-directory` ENOTDIR — a file path.
 *  - `invalid`      not an absolute path (we never resolve against a cwd).
 *  - `unavailable`  the validation transport failed; never treat this as a usable folder.
 */
export interface DirRefusal {
  ok: false
  reason: 'denied' | 'missing' | 'not-a-directory' | 'invalid' | 'unavailable'
  path: string
}

export type DirResult = DirListing | DirRefusal

export interface ListDirRequest {
  /** Absolute. `FS_DRIVE_ROOT` asks for the Windows drive list. */
  path: string
  /** Dotfolders are hidden by default. (Windows' HIDDEN attribute is not readable
   *  from `fs.Dirent`, so this is the dot rule on every platform — say so in the UI.) */
  showHidden?: boolean
}

/** Sorted case-insensitively, THEN capped — so truncation is deterministic. */
export const FS_LIST_CAP = 500
