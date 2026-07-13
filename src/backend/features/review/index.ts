// Pre-ship diff review. Read verbs build one exact Git snapshot; the mutating verb
// merges that commit, never a movable branch name. Electron-free, execFile arrays only.
import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ReviewDiff, ReviewFile, ReviewMergeResult, ReviewSnapshot } from '@contracts'
import { redactSecrets } from './redact'

export { redactSecrets, REDACTED } from './redact'

const MAX_PATCH_BYTES = 2 * 1024 * 1024
const OID = /^[0-9a-f]{40,64}$/i

const git = (cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> =>
  new Promise((resolveExec) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolveExec({ ok: false, stdout: String(stdout), error: String(stderr || err.message).slice(0, 400) })
        else resolveExec({ ok: true, stdout: String(stdout) })
      }
    )
  })

const normalizeRepoId = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Stable identity shared by a repository and all linked worktrees. */
export async function repoIdentity(cwd: string): Promise<string | null> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.stdout.trim()) return null
  let full = common.stdout.trim()
  if (!isAbsolute(full)) full = resolve(cwd, full)
  try {
    full = realpathSync.native(full)
  } catch {
    full = resolve(full)
  }
  return normalizeRepoId(full)
}

/** The base branch this worktree forked from (recorded at create; fallback: repo HEAD). */
async function baseFor(repo: string, worktree: string): Promise<string> {
  try {
    const gitDir = await git(worktree, ['rev-parse', '--absolute-git-dir'])
    if (gitDir.ok) {
      const recorded = readFileSync(join(gitDir.stdout.trim(), 'mogging-base'), 'utf8').trim()
      if (recorded) return recorded
    }
  } catch {
    /* not recorded */
  }
  const head = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return head.ok ? head.stdout.trim() : 'main'
}

/** Resolve the immutable source/destination graph used by review and approval. */
export async function snapshotForWorktree(repo: string, worktree: string): Promise<ReviewSnapshot | null> {
  const base = await baseFor(repo, worktree)
  const [repoId, branchRes, headRes, baseHeadRes] = await Promise.all([
    repoIdentity(repo),
    git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(worktree, ['rev-parse', 'HEAD^{commit}']),
    git(repo, ['rev-parse', `${base}^{commit}`])
  ])
  const branch = branchRes.ok ? branchRes.stdout.trim() : ''
  const head = headRes.ok ? headRes.stdout.trim() : ''
  const baseHead = baseHeadRes.ok ? baseHeadRes.stdout.trim() : ''
  if (!repoId || !branch || !OID.test(head) || !OID.test(baseHead)) return null
  const mergeBaseRes = await git(worktree, ['merge-base', baseHead, head])
  const mergeBase = mergeBaseRes.ok ? mergeBaseRes.stdout.trim() : ''
  if (!OID.test(mergeBase)) return null
  return { repoId, branch, head, base, baseHead, mergeBase }
}

/** Split a unified patch into per-file hunk groups. */
function parsePatch(patch: string): { path: string; hunks: string[] }[] {
  const files: { path: string; hunks: string[] }[] = []
  const parts = patch.split(/^diff --git /m).filter((p) => p.trim())
  for (const part of parts) {
    const pathMatch = /^\+\+\+ b\/(.+)$/m.exec(part) ?? /^--- a\/(.+)$/m.exec(part)
    const headerMatch = /^a\/(.+?) b\/(.+)$/m.exec(part)
    const path = pathMatch ? pathMatch[1].trim() : headerMatch ? headerMatch[2].trim() : '(unknown)'
    const hunkStart = part.search(/^@@/m)
    if (hunkStart < 0) {
      files.push({ path, hunks: [] })
      continue
    }
    const hunks = part.slice(hunkStart).split(/^(?=@@)/m).filter((h) => h.trim())
    files.push({ path, hunks })
  }
  return files
}

const failedDiff = (error?: string): ReviewDiff => ({
  base: '',
  branch: '',
  files: [],
  untracked: [],
  truncated: false,
  dirty: false,
  unreviewable: true,
  redactions: 0,
  error
})

/** Full displayed worktree diff. Dirty/unrenderable content remains visible but makes the
 *  result non-mergeable; only snapshot.head can ever be landed. */
export async function diffWorktree(repo: string, worktree: string): Promise<ReviewDiff> {
  const snapshot = await snapshotForWorktree(repo, worktree)
  if (!snapshot) return failedDiff('could not resolve the repository snapshot')

  const [numstat, patchRes, statusRes, untrackedRes] = await Promise.all([
    git(worktree, ['diff', snapshot.mergeBase, '--numstat', '--no-color']),
    git(worktree, ['diff', snapshot.mergeBase, '--unified=3', '--no-color']),
    git(worktree, ['status', '--porcelain', '--untracked-files=all']),
    git(worktree, ['ls-files', '--others', '--exclude-standard'])
  ])
  if (!numstat.ok) return { ...failedDiff(numstat.error), base: snapshot.base, branch: snapshot.branch, snapshot }
  if (!patchRes.ok) return { ...failedDiff(patchRes.error), base: snapshot.base, branch: snapshot.branch, snapshot }

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (const line of numstat.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
    if (m) {
      stats.set(m[3], {
        additions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2]),
        binary: m[1] === '-' || m[2] === '-'
      })
    }
  }

  const { text: cleanPatch, redactions } = redactSecrets(patchRes.stdout)
  const truncated = Buffer.byteLength(cleanPatch, 'utf8') > MAX_PATCH_BYTES
  const parsed = parsePatch(cleanPatch)
  const files: ReviewFile[] = []
  let budget = MAX_PATCH_BYTES
  let nonRendered = false
  for (const f of parsed) {
    const st = stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false }
    let hunks = f.hunks
    if (truncated) {
      const kept: string[] = []
      for (const h of hunks) {
        if (budget - Buffer.byteLength(h, 'utf8') <= 0) break
        budget -= Buffer.byteLength(h, 'utf8')
        kept.push(h)
      }
      hunks = kept
    }
    if (st.binary || hunks.length === 0) nonRendered = true
    files.push({ path: f.path, additions: st.additions, deletions: st.deletions, hunks })
  }

  const untracked = untrackedRes.ok ? untrackedRes.stdout.split('\n').filter((l) => l.trim()) : []
  const dirty = !statusRes.ok || !!statusRes.stdout.trim()
  return {
    base: snapshot.base,
    branch: snapshot.branch,
    snapshot,
    files,
    untracked,
    truncated,
    dirty,
    unreviewable: truncated || nonRendered,
    redactions
  }
}

/** Merge the exact reviewed commit. Branch and destination movement are detected; the source
 *  branch name is never passed to `git merge`, closing the check/use race. */
export async function mergeBranch(
  repo: string,
  snapshot: ReviewSnapshot,
  gate: { approved: boolean; override?: string } = { approved: false }
): Promise<ReviewMergeResult> {
  if (!gate.approved && gate.override !== 'override') return { ok: false, state: 'ungated' }
  if (!OID.test(snapshot.head) || !OID.test(snapshot.baseHead) || !OID.test(snapshot.mergeBase)) {
    return { ok: false, state: 'error', error: 'bad review snapshot' }
  }
  const [identity, currentBranch, currentBaseHead, currentSourceHead] = await Promise.all([
    repoIdentity(repo),
    git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repo, ['rev-parse', 'HEAD^{commit}']),
    git(repo, ['rev-parse', `${snapshot.branch}^{commit}`])
  ])
  if (
    identity !== snapshot.repoId ||
    !currentBranch.ok || currentBranch.stdout.trim() !== snapshot.base ||
    !currentBaseHead.ok || currentBaseHead.stdout.trim() !== snapshot.baseHead ||
    !currentSourceHead.ok || currentSourceHead.stdout.trim() !== snapshot.head
  ) {
    return { ok: false, state: 'stale', error: 'the reviewed source or destination changed; review again' }
  }

  const status = await git(repo, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, state: 'error', error: status.error }
  if (status.stdout.trim()) return { ok: false, state: 'dirty' }

  const res = await git(repo, ['merge', '--no-ff', '--no-edit', snapshot.head])
  if (res.ok) {
    const landed = await git(repo, ['merge-base', '--is-ancestor', snapshot.head, 'HEAD'])
    return landed.ok
      ? { ok: true, state: 'merged' }
      : { ok: false, state: 'error', error: 'merge completed but the reviewed commit is not reachable from HEAD' }
  }
  const conflicted = await git(repo, ['diff', '--name-only', '--diff-filter=U'])
  if (conflicted.ok && conflicted.stdout.trim()) return { ok: false, state: 'conflict' }
  return { ok: false, state: 'error', error: res.error }
}
