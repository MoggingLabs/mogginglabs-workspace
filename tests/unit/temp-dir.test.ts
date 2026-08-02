import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir, removeTempDirOrThrow, removeTempDirs } from './temp-dir'

// CLEANUP MUST NOT BE ABLE TO FAIL A SUITE.
//
// `rmSync(dir, { recursive: true, force: true })` in an afterAll throws EPERM on Windows
// whenever anything still holds a handle — a git process that has not fully exited, an
// indexer, antivirus. `force: true` suppresses "does not exist"; it does nothing about "in
// use", and there is no retry.
//
// Observed here: worktree-dirty-guard's five tests all PASSED and the file reported FAIL,
// because the teardown threw. A suite that goes red for a reason unrelated to the code under
// test is the same defect class as a gate that goes green for one — it makes the signal
// untrustworthy in the direction that costs an investigation. A leftover scratch directory is
// not a test result.

describe('removeTempDir', () => {
  it('removes a directory', () => {
    const dir = makeTempDir('temp-helper-')
    expect(() => removeTempDir(dir)).not.toThrow()
  })

  it('does not throw on a path that is already gone', () => {
    const dir = makeTempDir('temp-helper-')
    removeTempDir(dir)
    expect(() => removeTempDir(dir)).not.toThrow()
  })

  it('does not throw on a path that never existed', () => {
    expect(() => removeTempDir(resolve('/definitely/not/here/at/all'))).not.toThrow()
  })

  it('drains the list it was given, so a second call is a no-op', () => {
    const dirs = [makeTempDir('temp-helper-'), makeTempDir('temp-helper-')]
    removeTempDirs(dirs)
    expect(dirs).toHaveLength(0)
    expect(() => removeTempDirs(dirs)).not.toThrow()
  })

  it('retries rather than giving up on the first EPERM', () => {
    const src = readFileSync(resolve(import.meta.dirname, 'temp-dir.ts'), 'utf8')
    expect(src).toMatch(/maxRetries:\s*\d+/)
    expect(src).toMatch(/retryDelay:\s*\d+/)
  })
})

describe('no suite cleans up unguarded', () => {
  // The rule, enforced over the suite itself: a recursive rmSync in a test file must go through
  // the helper, or be wrapped. Otherwise the next scratch-dir test reintroduces the flake.
  it('every recursive rmSync in tests/unit is guarded', () => {
    const offenders: string[] = []
    for (const file of readdirSync(resolve(import.meta.dirname))) {
      if (!file.endsWith('.ts') || file === 'temp-dir.ts' || file === 'temp-dir.test.ts') continue
      const text = readFileSync(resolve(import.meta.dirname, file), 'utf8')
      const lines = text.split('\n')
      for (const [i, line] of lines.entries()) {
        if (!/rmSync\(/.test(line) || !/recursive:\s*true/.test(line)) continue
        // Guarded = inside a try. Look back a few lines; these are all short afterAll blocks.
        const window = lines.slice(Math.max(0, i - 3), i).join('\n')
        if (!/\btry\s*\{/.test(window)) offenders.push(`${file}:${i + 1}`)
      }
    }
    expect(offenders, `use removeTempDir() from ./temp-dir: ${offenders.join(', ')}`).toEqual([])
  })
})

describe('removeTempDirOrThrow reports an unmet precondition honestly', () => {
  // The SETUP helper's contract is "nothing resolves here", and when it cannot deliver that it
  // must say so in those terms. `rmSync` THROWS on EPERM rather than returning, so the first
  // version of the helper never reached its own existsSync check — the raw
  // `EPERM, Permission denied: \\?\C:\...` escaped instead, naming a temp path and nothing else.
  // That is what a full-suite run produced, and it reads as a defect in the guard under test.
  it('throws rather than reporting a precondition it did not establish', () => {
    // Reproduced differently per OS because what pins a directory differs: Windows refuses to
    // remove the current process's cwd; POSIX allows that, but not through a parent with no
    // write bit.
    const parent = makeTempDir('tdor-pinned-')
    const dir = join(parent, 'pinned')
    mkdirSync(dir)
    const cwdBefore = process.cwd()
    if (process.platform === 'win32') process.chdir(dir)
    else chmodSync(parent, 0o555)
    try {
      expect(() => removeTempDirOrThrow(dir)).toThrow(/precondition is unmet/)
      // ...and it names the path, so the failure points at the setup rather than the code
      // under test. The worktree flake cost an investigation precisely because it did not.
      expect(() => removeTempDirOrThrow(dir)).toThrow(dir)
    } finally {
      if (process.platform === 'win32') process.chdir(cwdBefore)
      else chmodSync(parent, 0o755)
      removeTempDir(parent)
    }
  })
})
