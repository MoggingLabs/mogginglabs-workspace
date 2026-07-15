import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

// The listing mechanics `fs-browse` (the wizard's dirs-only folder browser) and the
// explorer's files+dirs tree SHARE. Path MEANING already lived in fs-paths.ts so the two
// could never disagree about where a path leads; the read skeleton — errno→refusal
// mapping, symlink classification, the sort→cap→probe discipline — was still duplicated
// ~40 lines per side, comments and all. One definition here; each feature keeps only its
// own filter (dirs-only vs everything) and its own contract shapes.

/** The refusal vocabulary both listing contracts share (fs.ipc.ts / explorer.ipc.ts). */
export type ListRefusalReason = 'denied' | 'missing' | 'not-a-directory'

/** One level of dirents, or the typed refusal both browsers render as a state.
 *  Never throws: an unreadable folder is an ordinary thing to click on. */
export function readDirents(path: string): { ok: true; dirents: Dirent[] } | { ok: false; reason: ListRefusalReason } {
  try {
    return { ok: true, dirents: readdirSync(path, { withFileTypes: true }) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return {
      ok: false,
      reason: code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOTDIR' ? 'not-a-directory' : 'missing'
    }
  }
}

/**
 * Classify one dirent, following symlinks with ONE guarded stat — `Dirent.isDirectory()`
 * is FALSE for a junction or symlink pointing at a directory, and developers symlink
 * project folders. A broken link stats as a throw and classifies as `broken-link`:
 * fs-browse skips it (a folder that cannot be entered is not offered), the explorer
 * shows it as a leaf (an agent that wrote a dead link produced a fact worth seeing).
 */
export function classifyDirent(dir: string, d: Dirent): 'dir' | 'file' | 'broken-link' {
  if (d.isDirectory()) return 'dir'
  if (d.isSymbolicLink()) {
    try {
      return statSync(join(dir, d.name)).isDirectory() ? 'dir' : 'file'
    } catch {
      return 'broken-link'
    }
  }
  return 'file'
}

/** A `.git` entry exists inside (dir OR file — worktrees use a file). No git spawn;
 *  a child that raced away between readdir and stat is simply not a repo. */
export function probeIsRepo(childDir: string): boolean {
  try {
    return existsSync(join(childDir, '.git'))
  } catch {
    return false
  }
}

/** The one name comparator both listings sort with (case-insensitive, accent-aware). */
export const compareNames = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'accent' })
