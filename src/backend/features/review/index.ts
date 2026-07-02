// Pre-ship diff review (Phase-3/04). Electron-free; execFile ARG ARRAYS only. Read
// verbs: diff a worktree against the base it forked from (recorded by 3/03, fallback:
// the repo's current branch), numstat + unified hunks, REDACTED before anything leaves
// this module. ONE mutating verb: a guarded `merge --no-ff`, refused unless the repo
// is clean — conflicts are left for a human terminal, never auto-resolved.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewDiff, ReviewFile, ReviewMergeResult } from '@contracts'
import { redactSecrets } from './redact'

export { redactSecrets, REDACTED } from './redact'

const MAX_PATCH_BYTES = 2 * 1024 * 1024 // beyond this: stat stays, hunks truncate

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

/** The base branch this worktree forked from (recorded at create; fallback: repo HEAD). */
async function baseFor(repo: string, worktree: string): Promise<string> {
  try {
    const gitDir = await git(worktree, ['rev-parse', '--absolute-git-dir'])
    if (gitDir.ok) {
      const recorded = readFileSync(join(gitDir.stdout.trim(), 'mogging-base'), 'utf8').trim()
      if (recorded) return recorded
    }
  } catch {
    /* not recorded — fall through */
  }
  const head = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return head.ok ? head.stdout.trim() : 'main'
}

/** Split a unified patch into per-file hunk groups. Text-only transformation. */
function parsePatch(patch: string): { path: string; hunks: string[] }[] {
  const files: { path: string; hunks: string[] }[] = []
  const parts = patch.split(/^diff --git /m).filter((p) => p.trim())
  for (const part of parts) {
    const pathMatch = /^\+\+\+ b\/(.+)$/m.exec(part) ?? /^--- a\/(.+)$/m.exec(part)
    const path = pathMatch ? pathMatch[1].trim() : '(unknown)'
    const hunkStart = part.search(/^@@/m)
    if (hunkStart < 0) {
      files.push({ path, hunks: [] }) // mode change / binary / rename without hunks
      continue
    }
    const body = part.slice(hunkStart)
    const hunks = body.split(/^(?=@@)/m).filter((h) => h.trim())
    files.push({ path, hunks })
  }
  return files
}

/** Full worktree diff vs its base (committed + working tree), redacted + capped. */
export async function diffWorktree(repo: string, worktree: string): Promise<ReviewDiff> {
  const base = await baseFor(repo, worktree)
  const branchRes = await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRes.ok ? branchRes.stdout.trim() : ''

  // Diff from the merge-base to the WORKING TREE: everything the agent did, committed
  // or not. Falls back to the base ref itself when merge-base fails (fresh branch).
  const mbRes = await git(worktree, ['merge-base', base, 'HEAD'])
  const from = mbRes.ok ? mbRes.stdout.trim() : base

  const numstat = await git(worktree, ['diff', from, '--numstat', '--no-color'])
  if (!numstat.ok) return { base, branch, files: [], untracked: [], truncated: false, redactions: 0, error: numstat.error }

  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstat.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
    if (m) stats.set(m[3], { additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) })
  }

  const patchRes = await git(worktree, ['diff', from, '--unified=3', '--no-color'])
  if (!patchRes.ok) return { base, branch, files: [], untracked: [], truncated: false, redactions: 0, error: patchRes.error }

  // REDACT before parsing — no un-scrubbed text survives past this line.
  const { text: cleanPatch, redactions } = redactSecrets(patchRes.stdout)

  const truncated = Buffer.byteLength(cleanPatch, 'utf8') > MAX_PATCH_BYTES
  const parsed = parsePatch(cleanPatch)
  const files: ReviewFile[] = []
  let budget = MAX_PATCH_BYTES
  for (const f of parsed) {
    const st = stats.get(f.path) ?? { additions: 0, deletions: 0 }
    let hunks = f.hunks
    if (truncated) {
      const kept: string[] = []
      for (const h of hunks) {
        if (budget - h.length <= 0) break
        budget -= h.length
        kept.push(h)
      }
      hunks = kept
    }
    files.push({ path: f.path, additions: st.additions, deletions: st.deletions, hunks })
  }

  const untrackedRes = await git(worktree, ['ls-files', '--others', '--exclude-standard'])
  const untracked = untrackedRes.ok ? untrackedRes.stdout.split('\n').filter((l) => l.trim()) : []

  return { base, branch, files, untracked, truncated, redactions }
}

/** The ONE mutating verb: merge a worktree branch into the repo, --no-ff, ONLY when
 *  the repo is clean AND the reviewer gate is open (4/03): a live sign-off, or the
 *  human override word typed VERBATIM. Conflicts are reported and left in progress
 *  for a human terminal — never auto-resolved, never abandoned silently. */
export async function mergeBranch(
  repo: string,
  branch: string,
  gate: { approved: boolean; override?: string } = { approved: false }
): Promise<ReviewMergeResult> {
  if (!gate.approved && gate.override !== 'override') return { ok: false, state: 'ungated' }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return { ok: false, state: 'error', error: 'bad branch name' }
  const status = await git(repo, ['status', '--porcelain'])
  if (!status.ok) return { ok: false, state: 'error', error: status.error }
  if (status.stdout.trim()) return { ok: false, state: 'dirty' }

  const res = await git(repo, ['merge', '--no-ff', '--no-edit', branch])
  if (res.ok) return { ok: true, state: 'merged' }

  // Conflict? (git leaves the merge in progress — exactly what "resolve in a terminal" means)
  const conflicted = await git(repo, ['diff', '--name-only', '--diff-filter=U'])
  if (conflicted.ok && conflicted.stdout.trim()) return { ok: false, state: 'conflict' }
  return { ok: false, state: 'error', error: res.error }
}
