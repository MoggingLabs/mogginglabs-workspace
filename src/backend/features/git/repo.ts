import * as fs from 'node:fs'
import * as path from 'node:path'

// Pure filesystem helpers for the read-only git probe. No subprocess here — walking up for a
// `.git` entry is cheaper than spawning `git`, gives us the repo root for dedup/caching, and is
// the fast "not a repo -> show nothing" path. Electron-free (@backend stays Node-only).

/**
 * Walk up from `cwd` to the nearest directory that contains a `.git` entry (a dir for a normal
 * repo, or a FILE for a worktree/submodule gitdir pointer). Returns the repo root, or null when
 * `cwd` is empty/unreadable or not inside a repo. Bounded by the filesystem root.
 */
export function findRepoRoot(cwd: string): string | null {
  if (!cwd) return null
  let dir: string
  try {
    dir = path.resolve(cwd)
  } catch {
    return null
  }
  // Guard against symlink loops / pathological depth.
  for (let i = 0; i < 256; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir
    } catch {
      /* unreadable dir — treat as no repo here, keep walking up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
  }
  return null
}

/**
 * Best-effort branch name straight from `<root>/.git/HEAD`, used only as a fallback when the
 * `git` binary can't be spawned. `ref: refs/heads/<branch>` -> `<branch>`; a raw SHA -> null
 * (detached). Only handles a real `.git` DIRECTORY (worktrees store a gitdir pointer file).
 */
export function readHeadBranch(root: string): string | null {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m ? m[1] : null
  } catch {
    return null
  }
}
