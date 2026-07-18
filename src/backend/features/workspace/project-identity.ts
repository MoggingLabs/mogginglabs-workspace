import * as path from 'node:path'
import { UNFILED_PROJECT_KEY } from '@contracts'
import { findRepoRoot, readGitLayout } from '../git'

// The board-v2 PROJECT identity rule, extracted VERBATIM from src/main/board.ts so the
// workspace brain (ADR 0018.c) reuses the same resolver instead of forking it — two
// resolvers would eventually give one directory two identities, and then a worktree's
// brain and its board would disagree about which project they belong to. Electron-free;
// the board's behavior is unchanged (BOARDV2 holds the line).

/** Case-folded on Windows for COMPARISON only: two spellings of one folder are
 *  one project — but the stored key keeps its real casing, because it is also a
 *  real directory the queue launches into and gh runs against. */
export const foldProjectKey = (p: string): string =>
  process.platform === 'win32' ? p.toLocaleLowerCase('en-US') : p

/**
 * The canonical project key for a directory: the repo ROOT for a git checkout,
 * and — the load-bearing case — the PARENT repo's root for a linked worktree,
 * so every `.mogging/worktrees/<slug>` workspace shares its project's board
 * (and its brain). A non-repo folder is its own project. Empty/unresolvable →
 * the Unfiled key.
 */
export function projectKeyForCwd(cwd: string): string {
  if (!cwd) return UNFILED_PROJECT_KEY
  const root = findRepoRoot(cwd)
  if (!root) {
    try {
      return path.resolve(cwd)
    } catch {
      return UNFILED_PROJECT_KEY
    }
  }
  const layout = readGitLayout(root)
  if (layout?.linkedWorktree) {
    // commonDir is the PARENT repo's .git — its dirname is the parent root.
    return path.dirname(path.resolve(layout.commonDir))
  }
  return path.resolve(root)
}
