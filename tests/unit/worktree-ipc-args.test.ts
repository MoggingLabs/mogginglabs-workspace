import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizePaneCwd } from '@backend/features/agent-state'

// THE UNVALIDATED IPC PATH, pinned.
//
// Four worktree handlers took a path from the renderer and checked it with
// `typeof p === 'string' && p`. Every one of those paths then became `git -C <path>` or an
// fs call:
//
//   - a RELATIVE path resolves against main's cwd, which in a packaged build is the
//     install directory — so `git -C .` ran against the application itself;
//   - a control character rode straight into an argv;
//   - a path that no longer exists produced git's error instead of ours.
//
// Nine other call sites in this codebase already ran the real normalizer on paths of
// exactly this kind. These four did not.
//
// The handlers themselves live behind ipcMain, so what is asserted here is the predicate
// they now use — the thing that was missing.

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const realDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wtipc-'))
  dirs.push(d)
  return d
}

/** Exactly the predicate src/main/worktrees.ts applies to every incoming path. */
const repoPath = (raw: unknown): string | null => normalizePaneCwd(raw, { mustExist: true })

describe('worktree IPC path validation', () => {
  it('accepts a real absolute directory', () => {
    const d = realDir()
    expect(repoPath(d)).toBe(d)
  })

  it('refuses everything the string check let through', () => {
    for (const bad of [
      'relative/repo', // resolves against main's cwd — the install dir when packaged
      '.',
      '..',
      '',
      '   ',
      null,
      undefined,
      42,
      {},
      ['/tmp'],
      '/tmp/\x00evil',
      '/tmp/a\x1bb',
      '/x'.repeat(40_000)
    ]) {
      expect(repoPath(bad), JSON.stringify(bad)?.slice(0, 24)).toBeNull()
    }
  })

  it('refuses an absolute path that does not exist', () => {
    expect(repoPath(join(tmpdir(), 'mogging-no-such-repo-' + Date.now()))).toBeNull()
  })

  it('refuses a path that exists but is a FILE', () => {
    expect(repoPath(process.execPath)).toBeNull()
  })

  it('does NOT refuse a UNC path — a repo on a share is ordinary', () => {
    // Unlike a deep link, these arrive from the app's own renderer. The refusal that
    // belongs on untrusted input would break a legitimate setup here.
    expect(normalizePaneCwd('\\\\host\\share\\repo', { mustExist: false, platform: 'win32' })).toBe(
      '\\\\host\\share\\repo'
    )
  })
})
