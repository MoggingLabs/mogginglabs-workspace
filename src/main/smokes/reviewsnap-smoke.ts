import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '@backend/features/worktrees'
import { diffWorktree, mergeBranch, repoIdentity } from '@backend/features/review'
import type { Approval, ReviewSnapshot } from '@contracts'
import { approvalMatchesSnapshot, mergeReviewedWorktree } from '../review'

// Audit regression gate: approval is repository+object identity, never a branch-name flag.
// It also holds the review/merge content contract: dirty, untracked, binary and truncated
// work cannot land; source/base movement invalidates the sign-off; an exact clean snapshot lands.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

function makeRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `mogging-review-snapshot-${label}-`))
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.email', 'smoke@mogging.test'])
  git(repo, ['config', 'user.name', 'Mogging Smoke'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'README.md'), `${label}\n`)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  return repo
}

const approvalFor = (snapshot: ReviewSnapshot, pane = '2'): Approval => ({
  snapshot,
  repoId: snapshot.repoId,
  branch: snapshot.branch,
  byPaneId: pane,
  byRole: 'reviewer',
  ts: Date.now()
})

export async function runReviewSnapSmoke(): Promise<void> {
  let result: Record<string, unknown> = { pass: false }
  try {
    // Same branch text in another repo must never inherit approval.
    const repoA = makeRepo('a')
    const wtA = await createWorktree(repoA)
    if (!wtA.ok || !wtA.path || !wtA.branch) throw new Error('worktree A failed')
    writeFileSync(join(wtA.path, 'a.txt'), 'reviewed A\n')
    git(wtA.path, ['add', '-A'])
    git(wtA.path, ['commit', '-m', 'A work'])
    const diffA = await diffWorktree(repoA, wtA.path)
    if (!diffA.snapshot) throw new Error('snapshot A missing')
    const approvalA = approvalFor(diffA.snapshot)
    const exactMatch = approvalMatchesSnapshot(approvalA, diffA.snapshot)
    const repoB = makeRepo('b')
    const repoBId = await repoIdentity(repoB)
    const crossRepoSnapshot = { ...diffA.snapshot, repoId: repoBId ?? 'missing' }
    const crossRepoRefused = !approvalMatchesSnapshot(approvalA, crossRepoSnapshot)

    // Dirty/untracked source is visible but cannot enter the merge path.
    writeFileSync(join(wtA.path, 'untracked.txt'), 'not committed\n')
    const dirtyDiff = await diffWorktree(repoA, wtA.path)
    const dirtyRefused =
      dirtyDiff.dirty &&
      dirtyDiff.untracked.includes('untracked.txt') &&
      (await mergeReviewedWorktree({ repo: repoA, worktree: wtA.path, override: 'override' }, [approvalA])).state === 'unreviewable'
    rmSync(join(wtA.path, 'untracked.txt'))

    // Source movement after approval invalidates the sign-off and the old snapshot.
    writeFileSync(join(wtA.path, 'a2.txt'), 'new commit\n')
    git(wtA.path, ['add', '-A'])
    git(wtA.path, ['commit', '-m', 'source moved'])
    const movedDecision = await mergeReviewedWorktree({ repo: repoA, worktree: wtA.path }, [approvalA])
    const movedBackend = await mergeBranch(repoA, diffA.snapshot, { approved: true })
    const sourceMoveRefused = movedDecision.state === 'ungated' && movedBackend.state === 'stale'

    // Destination movement after review is equally stale.
    const repoBase = makeRepo('base')
    const wtBase = await createWorktree(repoBase)
    if (!wtBase.ok || !wtBase.path) throw new Error('worktree base failed')
    writeFileSync(join(wtBase.path, 'feature.txt'), 'feature\n')
    git(wtBase.path, ['add', '-A'])
    git(wtBase.path, ['commit', '-m', 'feature'])
    const baseDiff = await diffWorktree(repoBase, wtBase.path)
    if (!baseDiff.snapshot) throw new Error('base snapshot missing')
    writeFileSync(join(repoBase, 'main.txt'), 'main moved\n')
    git(repoBase, ['add', '-A'])
    git(repoBase, ['commit', '-m', 'base moved'])
    const baseMoveRefused = (await mergeBranch(repoBase, baseDiff.snapshot, { approved: true })).state === 'stale'

    // Non-renderable binary and oversized patches are explicitly non-mergeable.
    const repoBinary = makeRepo('binary')
    const wtBinary = await createWorktree(repoBinary)
    if (!wtBinary.ok || !wtBinary.path) throw new Error('binary worktree failed')
    writeFileSync(join(wtBinary.path, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 4]))
    git(wtBinary.path, ['add', '-A'])
    git(wtBinary.path, ['commit', '-m', 'binary'])
    const binaryDiff = await diffWorktree(repoBinary, wtBinary.path)
    const binaryRefused = binaryDiff.unreviewable

    const repoMode = makeRepo('mode')
    const wtMode = await createWorktree(repoMode)
    if (!wtMode.ok || !wtMode.path) throw new Error('mode worktree failed')
    git(wtMode.path, ['update-index', '--chmod=+x', 'README.md'])
    // update-index flips the INDEX bit only. On core.filemode=true platforms (linux/mac) the
    // on-disk file must agree, or the commit records 755 while the worktree stays 644 — the
    // mergeBase->worktree diff is then EMPTY (644 -> 644) and the fixture never contains the
    // mode-only change this gate asserts on. Windows takes worktree modes from the index
    // (core.filemode=false), which is why the fixture looked complete when authored there.
    if (process.platform !== 'win32') chmodSync(join(wtMode.path, 'README.md'), 0o755)
    git(wtMode.path, ['commit', '-m', 'mode only'])
    const modeDiff = await diffWorktree(repoMode, wtMode.path)
    const modeOnlyRefused = modeDiff.unreviewable && modeDiff.files.some((file) => file.path === 'README.md' && file.hunks.length === 0)

    const repoLarge = makeRepo('large')
    const wtLarge = await createWorktree(repoLarge)
    if (!wtLarge.ok || !wtLarge.path) throw new Error('large worktree failed')
    writeFileSync(join(wtLarge.path, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 8192))
    git(wtLarge.path, ['add', '-A'])
    git(wtLarge.path, ['commit', '-m', 'large'])
    const largeDiff = await diffWorktree(repoLarge, wtLarge.path)
    const truncatedRefused = largeDiff.truncated && largeDiff.unreviewable

    // Exact, clean, fully rendered snapshot lands and is reachable from destination HEAD.
    const repoExact = makeRepo('exact')
    const wtExact = await createWorktree(repoExact)
    if (!wtExact.ok || !wtExact.path) throw new Error('exact worktree failed')
    writeFileSync(join(wtExact.path, 'landed.txt'), 'exact reviewed content\n')
    git(wtExact.path, ['add', '-A'])
    git(wtExact.path, ['commit', '-m', 'exact work'])
    const exactDiff = await diffWorktree(repoExact, wtExact.path)
    if (!exactDiff.snapshot) throw new Error('exact snapshot missing')
    const exactMerge = await mergeReviewedWorktree(
      { repo: repoExact, worktree: wtExact.path },
      [approvalFor(exactDiff.snapshot)]
    )
    const exactLanded =
      exactMerge.state === 'merged' &&
      existsSync(join(repoExact, 'landed.txt')) &&
      git(repoExact, ['merge-base', '--is-ancestor', exactDiff.snapshot.head, 'HEAD']) === ''

    const pass =
      exactMatch && crossRepoRefused && dirtyRefused && sourceMoveRefused && baseMoveRefused &&
      binaryRefused && modeOnlyRefused && truncatedRefused && exactLanded
    result = {
      pass,
      exactMatch,
      crossRepoRefused,
      dirtyRefused,
      sourceMoveRefused,
      movedDecision,
      movedBackend,
      baseMoveRefused,
      binaryRefused,
      modeOnlyRefused,
      truncatedRefused,
      exactMerge,
      exactLanded
    }
  } catch (e) {
    result = { pass: false, error: String(e) }
  }
  try {
    writeFileSync(join(process.cwd(), 'out', 'reviewsnap-result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  app.exit(result.pass ? 0 : 1)
}
