import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWorktree, listWorktrees, removeWorktree } from '@backend/features/worktrees'
import { resolveOnPath } from '@backend/platform/env-path'

// THE DIRTY CHECK THAT FAILED OPEN, pinned.
//
// removeWorktree refuses to delete a worktree with uncommitted work, because that work is
// exactly what the review gate exists to look at. The refusal read:
//
//     if (st.ok && st.stdout.trim().length > 0) return { reason: 'dirty' }
//
// so a `git status` that could not be READ — a timeout on a slow disk, a maxBuffer overrun
// on a huge status, a git that failed to run — was treated as "nothing to lose", and the
// checkout was deleted. The unknown case took the destructive branch.
//
// listWorktrees had the same shape, rendering an unreadable worktree as CLEAN: the
// reassuring answer, and the one a user acts on by deleting it.
//
// These run real git against real temp repos — the refusals are only worth something if
// they match what git actually does.

const hasGit = !!resolveOnPath('git')
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

function repoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-dirty-'))
  made.push(dir)
  const git = (...a: string[]): void => {
    execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'first')
  return dir
}

describe.skipIf(!hasGit)('worktree dirty guard', () => {
  it('refuses to remove a worktree holding uncommitted work', async () => {
    const repo = repoWithCommit()
    const created = await createWorktree(repo)
    expect(created.ok).toBe(true)
    const wt = created.path
    expect(wt).toBeTruthy()
    if (!wt) return

    writeFileSync(join(wt, 'agent-work.txt'), 'the thing the agent just wrote\n')
    const res = await removeWorktree(repo, wt)
    expect(res).toMatchObject({ ok: false, reason: 'dirty' })
    // The point of the refusal: the work is still there.
    expect(existsSync(join(wt, 'agent-work.txt'))).toBe(true)
  })

  it('reports that worktree as dirty in the listing', async () => {
    const repo = repoWithCommit()
    const created = await createWorktree(repo)
    const wt = created.path
    expect(wt).toBeTruthy()
    if (!wt) return
    writeFileSync(join(wt, 'agent-work.txt'), 'uncommitted\n')
    const list = await listWorktrees(repo)
    expect(list.find((w) => w.path === wt)?.dirty).toBe(true)
  })

  it('removes a clean worktree', async () => {
    // The guard must not become "never remove anything".
    const repo = repoWithCommit()
    const created = await createWorktree(repo)
    const wt = created.path
    expect(wt).toBeTruthy()
    if (!wt) return
    const res = await removeWorktree(repo, wt)
    expect(res).toMatchObject({ ok: true })
    expect(existsSync(wt)).toBe(false)
  })

  it('--force still removes a dirty worktree — the user may still decide', async () => {
    const repo = repoWithCommit()
    const created = await createWorktree(repo)
    const wt = created.path
    expect(wt).toBeTruthy()
    if (!wt) return
    writeFileSync(join(wt, 'agent-work.txt'), 'uncommitted\n')
    const res = await removeWorktree(repo, wt, true)
    expect(res).toMatchObject({ ok: true })
  })

  // THE regression: an UNREADABLE status must refuse, not delete. Provoked by removing the
  // worktree's directory out from under git, so `git status` in it cannot run at all —
  // st.ok is false with no output, which is precisely the shape that used to read as clean.
  it('refuses when the status cannot be read at all', async () => {
    const repo = repoWithCommit()
    const created = await createWorktree(repo)
    const wt = created.path
    expect(wt).toBeTruthy()
    if (!wt) return
    rmSync(wt, { recursive: true, force: true })
    const res = await removeWorktree(repo, wt)
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ reason: 'dirty' }) // unknown refuses, exactly as dirty does
  })
})
