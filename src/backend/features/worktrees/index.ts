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
  WorktreeInfo,
  WorktreePreflight,
  WorktreePreflightReason
} from '@contracts'
import { resolveOnPath } from '../../platform/env-path'

/** Metadata calls (rev-parse, status, worktree list) answer in milliseconds; a slow one is a
 *  hung git, not a big repo. */
const QUICK_MS = 15_000
/** `git worktree add` CHECKS OUT THE WHOLE TREE. On a real repo that is thousands of files,
 *  and with several agents isolating at once, on a spinning disk, behind Windows Defender's
 *  on-write scanner, it is minutes — not seconds. The old 15s ceiling turned a slow-but-fine
 *  checkout into "Could not isolate every agent", and the rollback then deleted the work the
 *  timeout had interrupted. A checkout gets time; a HUNG git still cannot hang forever. */
const CHECKOUT_MS = 10 * 60_000

const git = (
  cwd: string,
  args: string[],
  timeout = QUICK_MS
): Promise<{ ok: boolean; stdout: string; error?: string; timedOut?: boolean }> =>
  new Promise((resolveExec) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', windowsHide: true, timeout },
      (err, stdout, stderr) => {
        if (!err) return resolveExec({ ok: true, stdout: String(stdout) })
        // execFile reports a timeout as a KILL, not an error code — without this the user
        // gets git's (empty) stderr and no idea that anything was ever waited for.
        const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        const message = timedOut
          ? `git took longer than ${Math.round(timeout / 1000)}s and was stopped`
          : missing
            ? 'git could not be run — it is not on this app’s PATH'
            : String(stderr || err.message)
        resolveExec({ ok: false, stdout: String(stdout), error: message.slice(0, 400), timedOut })
      }
    )
  })

/**
 * Can `repo` be isolated? Every answer here is one the UI can act on, and it is asked BEFORE
 * the toggle is offered rather than discovered at Launch — see WorktreePreflight for why that
 * distinction cost a user their whole first attempt.
 */
export async function preflightWorktrees(repo: string): Promise<WorktreePreflight> {
  const refuse = (reason: WorktreePreflightReason, detail?: string): WorktreePreflight => ({ ok: false, reason, detail })
  if (!repo.trim()) return refuse('not-a-repo')
  // Asked of the PATH rather than by running git, so "not installed" and "installed but
  // invisible to this process" produce the same, true, actionable answer.
  if (!resolveOnPath('git')) return refuse('no-git')

  const inside = await git(repo, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) {
    // git ran but said no. A missing binary was already ruled out above, so anything left
    // that mentions a repository is the ordinary "this folder isn't one".
    return /not a git repos|does not appear to be a git repos/i.test(inside.error ?? '')
      ? refuse('not-a-repo')
      : refuse('unsupported', inside.error)
  }
  if (inside.stdout.trim() !== 'true') return refuse('not-a-repo')

  // A repo with no commits has no HEAD to fork a worktree from. `git worktree add -b` fails
  // with "invalid reference: HEAD", which reads like a bug in this app rather than "commit
  // something first".
  const head = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head.ok || !head.stdout.trim()) return refuse('no-commits')

  // The managed root has to be creatable, and finding that out now beats finding it out
  // after the first three worktrees already exist.
  try {
    mkdirSync(worktreesRoot(repo), { recursive: true })
  } catch (e) {
    return refuse('not-writable', String(e).slice(0, 200))
  }
  return { ok: true, reason: 'ok' }
}

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
    // The one call that copies a whole working tree — it gets the checkout budget, not the
    // metadata one (see CHECKOUT_MS).
    const res = await git(repo, ['worktree', 'add', path, '-b', branch], CHECKOUT_MS)
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

/** Git prints each worktree's PHYSICAL path. Re-spell it under the caller's own
 *  `.mogging/worktrees` root when it lives there: every consumer compares these entries
 *  against caller-namespace paths (the pane cwd feeding the dirty pre-check, the rail
 *  chips), and under an aliased repo prefix (8.3 short TEMP on CI Windows, macOS's
 *  symlinked /var) the physical spelling matches none of them — the dirty refusal then
 *  arrives only AFTER the pane was closed. */
function inRepoNamespace(repo: string, p: string): string {
  const root = worktreesRoot(repo)
  let physRoot: string
  try {
    physRoot = realpathSync.native(root)
  } catch {
    return p
  }
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const abs = resolve(p)
  if (fold(abs) === fold(physRoot)) return root
  if (fold(abs).startsWith(fold(physRoot + sep))) return join(root, abs.slice(physRoot.length + 1))
  return p
}

/** Managed worktrees of a repo (porcelain-parsed), each with a live dirty flag. */
export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const res = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return []
  const out: WorktreeInfo[] = []
  let current: { path?: string; branch?: string } = {}
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: inRepoNamespace(repo, line.slice('worktree '.length).trim()) }
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
