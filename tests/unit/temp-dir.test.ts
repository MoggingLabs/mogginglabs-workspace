import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir, removeTempDirs } from './temp-dir'

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
