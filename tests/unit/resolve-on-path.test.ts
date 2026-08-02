import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isRunnableEntry, resolveOnPath } from '@backend/platform/env-path'

// THE WINDOWSAPPS ALIAS, pinned.
//
// resolveOnPath decided "is this a program?" with `statSync(p).isFile()`, which asks a
// different question and gets the wrong answer for an entire class of program on Windows.
//
// A WindowsApps **App Execution Alias** — how winget, python and every Store-delivered CLI
// appear on PATH — is a zero-length reparse point that `stat` cannot follow. Measured on
// this machine:
//
//     statSync(…\WindowsApps\winget.exe)  -> throws EACCES
//     accessSync(same, X_OK)              -> ok
//     execFile('winget', ['--version'])   -> v1.29.280
//
// So the resolver answered null for a program that runs perfectly well, and one-click setup
// told every Windows user without Node that "winget isn't available on this PC" — on a
// machine where winget was installed and working. `lstat` answers the directory question
// without following the reparse point; `accessSync(X_OK)` answers executability directly,
// which is also the right question on POSIX where it checks the executable bit.

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'resolve-'))
  made.push(d)
  return d
}

const isWin = process.platform === 'win32'

describe('isRunnableEntry', () => {
  it('rejects a path that does not exist', () => {
    expect(isRunnableEntry(join(tempDir(), 'nope'))).toBe(false)
  })

  it('rejects a DIRECTORY — it is X_OK on POSIX, which means traversable', () => {
    const d = tempDir()
    mkdirSync(join(d, 'bin'))
    expect(isRunnableEntry(join(d, 'bin'))).toBe(false)
  })

  it('accepts a real executable', () => {
    // node itself: present on every runner, and genuinely runnable.
    expect(isRunnableEntry(process.execPath)).toBe(true)
  })

  it.skipIf(isWin)('rejects a file without the executable bit (POSIX)', () => {
    const d = tempDir()
    const f = join(d, 'script')
    writeFileSync(f, '#!/bin/sh\necho hi\n')
    chmodSync(f, 0o644)
    expect(isRunnableEntry(f)).toBe(false)
    chmodSync(f, 0o755)
    expect(isRunnableEntry(f)).toBe(true)
  })
})

describe('resolveOnPath', () => {
  it('finds a program on a supplied PATH', () => {
    const d = tempDir()
    const name = isWin ? 'tool.cmd' : 'tool'
    const f = join(d, name)
    writeFileSync(f, isWin ? '@echo off\n' : '#!/bin/sh\n')
    if (!isWin) chmodSync(f, 0o755)
    const env = { PATH: d, PATHEXT: '.EXE;.CMD;.BAT' }
    const found = resolveOnPath('tool', env)
    // Compared case-insensitively on Windows: the resolver builds the candidate from
    // PATHEXT's own spelling ('.CMD'), so it answers `tool.CMD` for a file created as
    // `tool.cmd`. Same file — the filesystem is case-insensitive there.
    const same = (a: string | null, b: string): boolean =>
      isWin ? a?.toLowerCase() === b.toLowerCase() : a === b
    expect(same(found, f), `${found} vs ${f}`).toBe(true)
  })

  it('returns null for something that is not there', () => {
    expect(resolveOnPath('definitely-not-a-real-binary-xyz', { PATH: tempDir() })).toBeNull()
  })

  it('does not mistake a DIRECTORY named like the tool for the tool', () => {
    const d = tempDir()
    mkdirSync(join(d, 'codex'))
    expect(resolveOnPath('codex', { PATH: d, PATHEXT: '' })).toBeNull()
  })

  // THE regression, on the platform that has it. Skipped elsewhere — but the rows above
  // hold the rule on every runner, so a POSIX-only CI still defends the change.
  it.skipIf(!isWin)('finds a WindowsApps App Execution Alias (winget)', () => {
    const found = resolveOnPath('winget')
    // Only assert when this machine actually has one — a Windows box without the Store
    // aliases is a legitimate configuration, not a failure.
    const wingetDir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')
    if (!(process.env.PATH ?? '').toLowerCase().includes(wingetDir.toLowerCase())) return
    expect(found, 'winget is on PATH as an alias but resolveOnPath said null').toBeTruthy()
  })
})
