// Worktree-per-agent isolation (Phase-3/03). Electron-free; shells out to git via
// execFile ARG ARRAYS only (no shell-string interpolation, no injection surface).
// Scope is deliberately tiny: `git worktree add/list/remove` — never checkout, reset,
// or merge (Phase-3/04 owns merges). Managed worktrees live under
// <repo>/.mogging/worktrees/<slug> on branch mogging/<slug>; slugs are RANDOM — task
// text or user input never becomes a path or branch name (ADR 0002 posture).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  CreateWorktreeResult,
  RemoveWorktreeResult,
  WorktreeInfo
} from '@contracts'

const git = (cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> =>
  new Promise((resolveExec) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) resolveExec({ ok: false, stdout: String(stdout), error: String(stderr || err.message).slice(0, 400) })
        else resolveExec({ ok: true, stdout: String(stdout) })
      }
    )
  })

const worktreesRoot = (repo: string): string => join(repo, '.mogging', 'worktrees')

/** Is `p` inside the repo's managed worktrees dir? (removal + review guard)
 *
 *  Case-FOLDED on win32, where the filesystem is case-insensitive and the two sides reach us
 *  spelled differently all the time: git prints the worktree path with the casing it recorded
 *  at `worktree add`, while `repo` comes from the IPC caller (a workspace re-added as
 *  `c:\github\repo` instead of `C:\GitHub\repo`). A raw startsWith then answers false for the
 *  app's OWN worktrees — listWorktrees filters every one of them out (the UI shows none) and
 *  removeWorktree refuses with 'not-managed': invisible AND undeletable. The trailing `sep`
 *  keeps this a path-BOUNDARY test, so `…\worktrees-2\x` is never read as inside `…\worktrees`.
 *
 *  Checked in BOTH namespaces for the same reason the fold exists: git prints the PHYSICAL
 *  path, while `repo` keeps the caller's spelling — under an aliased prefix (8.3 short path
 *  or junction on Windows, macOS's symlinked /var temp) the two never prefix-match lexically,
 *  and the app's own worktrees go invisible again. A path that is inside in EITHER spelling
 *  is ours. */
export function isManaged(repo: string, p: string): boolean {
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const phys = (s: string): string => {
    try {
      return realpathSync.native(s)
    } catch {
      return resolve(s) // target gone or unreadable -> the lexical spelling is all there is
    }
  }
  const inside = (child: string, root: string): boolean => fold(child).startsWith(fold(root + sep))
  const root = resolve(worktreesRoot(repo))
  return inside(resolve(p), root) || inside(phys(p), phys(root))
}

/** Create one isolated worktree on a fresh random branch. Never touches HEAD/index. */
export async function createWorktree(repo: string): Promise<CreateWorktreeResult> {
  try {
    const root = worktreesRoot(repo)
    mkdirSync(root, { recursive: true })
    // Self-ignoring dir: the repo never sees .mogging/ as untracked noise.
    const ignore = join(repo, '.mogging', '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')

    const slug = randomBytes(4).toString('hex')
    const path = join(root, slug)
    const branch = `mogging/${slug}`
    const baseRes = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const res = await git(repo, ['worktree', 'add', path, '-b', branch])
    if (!res.ok) return { ok: false, error: res.error }
    // Record the fork base INSIDE the worktree's git dir (invisible to git status) —
    // the review surface (3/04) diffs against exactly this.
    try {
      const gitDir = await git(path, ['rev-parse', '--absolute-git-dir'])
      if (baseRes.ok && gitDir.ok) {
        writeFileSync(join(gitDir.stdout.trim(), 'mogging-base'), baseRes.stdout.trim() + '\n')
      }
    } catch {
      /* best effort — review falls back to the repo's current branch */
    }
    return { ok: true, path, branch }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 400) }
  }
}

/** Managed worktrees of a repo (porcelain-parsed), each with a live dirty flag. */
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const res = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return []
  const out: WorktreeInfo[] = []
  let current: { path?: string; branch?: string } = {}
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice('worktree '.length).trim() }
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
    else if (!line.trim() && current.path) {
      if (isManaged(repo, current.path)) out.push({ path: current.path, branch: current.branch ?? '', dirty: false })
      current = {}
    }
  }
  if (current.path && isManaged(repo, current.path)) {
    out.push({ path: current.path, branch: current.branch ?? '', dirty: false })
  }
  for (const wt of out) {
    const st = await git(wt.path, ['status', '--porcelain'])
    wt.dirty = st.ok && st.stdout.trim().length > 0
  }
  return out
}

/** Remove a MANAGED worktree. Dirty worktrees are refused unless force (the work in
 *  them is exactly what Phase-3/04 reviews — never silently destroyed). The branch is
 *  kept either way. */
export async function removeWorktree(
  repo: string,
  path: string,
  force = false
): Promise<RemoveWorktreeResult> {
  try {
    if (!isManaged(repo, path)) return { ok: false, reason: 'not-managed' }
    if (!force) {
      const st = await git(path, ['status', '--porcelain'])
      if (st.ok && st.stdout.trim().length > 0) return { ok: false, reason: 'dirty' }
    }
    const args = force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path]
    const res = await git(repo, args)
    if (!res.ok) return { ok: false, reason: 'error', error: res.error }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'error', error: String(e).slice(0, 400) }
  }
}
