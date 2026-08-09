import { describe, expect, it } from 'vitest'
import { exitCodeFor } from '../../src/pty-daemon/exit-code'

// The epitaph's number. node-pty reports {exitCode, signal}, and on POSIX a WIFSIGNALED death
// yields exitCode 0 with the number in `signal` — so reading only exitCode made a SIGKILL or a
// SIGSEGV byte-identical to the user typing `exit`. That is wrong exactly on the crashes the
// dead-pane epitaph exists to diagnose, and it violates the seam's stated contract: "a crash, a
// clean exit and a kill are distinguishable from the pane itself".
//
// This is a UNIT rather than a gate act on purpose: the behaviour is unobservable on win32
// (ConPTY names a real code for every death and never sets `signal`), so a gate on a Windows box
// cannot bite it in either direction. The rule is pure, so it can be proven on every platform.

describe('exitCodeFor', () => {
  it('names a signal death as 128+signal (SIGKILL reads 137, not 0)', () => {
    expect(exitCodeFor({ exitCode: 0, signal: 9 })).toBe(137)
  })

  it('distinguishes SIGSEGV from a clean exit', () => {
    expect(exitCodeFor({ exitCode: 0, signal: 11 })).toBe(139)
    expect(exitCodeFor({ exitCode: 0 })).toBe(0)
    expect(exitCodeFor({ exitCode: 0, signal: 11 })).not.toBe(exitCodeFor({ exitCode: 0 }))
  })

  it('passes a real exit code through untouched', () => {
    expect(exitCodeFor({ exitCode: 3, signal: 0 })).toBe(3)
    expect(exitCodeFor({ exitCode: 1 })).toBe(1)
    expect(exitCodeFor({ exitCode: 130 })).toBe(130)
  })

  it('is the identity on win32-shaped events (signal never set)', () => {
    for (const code of [0, 1, 2, 255]) expect(exitCodeFor({ exitCode: code })).toBe(code)
  })

  it('keeps the epitaph regex satisfied — the result is always a plain number', () => {
    for (const ev of [{ exitCode: 0, signal: 9 }, { exitCode: 7 }, { exitCode: 0, signal: 15 }]) {
      expect(String(exitCodeFor(ev))).toMatch(/^\d+$/)
    }
  })
})
