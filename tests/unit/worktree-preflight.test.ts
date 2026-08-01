import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { preflightWorktrees } from '@backend/features/worktrees'
import { resolveOnPath } from '@backend/platform/env-path'

/**
 * The preflight exists because the wizard used to enable worktree isolation on folders
 * where every `git worktree add` was guaranteed to fail, and the user only found out at
 * Launch — after picking a folder, a layout and a lineup. `isRepo` came from `probeGit`,
 * which DEGRADES to reading `.git/HEAD` when git cannot be run at all, so a folder read as
 * a repo on a machine with no reachable git.
 *
 * These run real `git` against real temp repos: the refusals are only worth anything if
 * they match what git actually does.
 */

const hasGit = !!resolveOnPath('git')
const made: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mogging-preflight-'))
  made.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

afterAll(() => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a worktree Windows still holds open — the OS temp sweep gets it */
    }
  }
})

describe.runIf(hasGit)('preflightWorktrees', () => {
  it('refuses a plain folder as not-a-repo', async () => {
    const result = await preflightWorktrees(tempDir())
    expect(result).toMatchObject({ ok: false, reason: 'not-a-repo' })
  })

  it('refuses an empty path without touching the disk', async () => {
    expect(await preflightWorktrees('   ')).toMatchObject({ ok: false, reason: 'not-a-repo' })
  })

  it('refuses a repo with NO COMMITS — the reason `git worktree add -b` really fails', async () => {
    // git's own words here are "fatal: invalid reference: HEAD", which reads as a bug in
    // this app rather than "commit something first".
    const dir = tempDir()
    git(dir, 'init', '-q')
    const result = await preflightWorktrees(dir)
    expect(result).toMatchObject({ ok: false, reason: 'no-commits' })
  })

  it('says NO-GIT when git is unreachable — even on a folder that is really a repo', async () => {
    // THE BUG, reproduced. This is the exact state the app was in: a genuine repository,
    // a `.git` directory anyone can read, and no `git` this process can execute — because
    // it was installed after the app captured its environment. `probeGit` answers "repo"
    // here (it falls back to reading .git/HEAD), which is what enabled the doomed toggle.
    // The preflight must answer the OTHER question: can we actually run the command.
    const dir = tempDir()
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Test')
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-qm', 'first')

    const realPath = process.env.PATH
    process.env.PATH = ''
    try {
      expect(await preflightWorktrees(dir)).toMatchObject({ ok: false, reason: 'no-git' })
    } finally {
      process.env.PATH = realPath
    }
    // …and the same folder passes the moment git is reachable again.
    expect(await preflightWorktrees(dir)).toEqual({ ok: true, reason: 'ok' })
  })

  it('accepts a repo with a commit', async () => {
    const dir = tempDir()
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'user.name', 'Test')
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-qm', 'first')
    expect(await preflightWorktrees(dir)).toEqual({ ok: true, reason: 'ok' })
  })
})
