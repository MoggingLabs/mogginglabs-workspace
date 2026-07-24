import { describe, expect, it } from 'vitest'
import { countSubmittedLines, isRecycledPpidEdge, type ProcRow } from '@backend/features/agent-state/agent-proc'
import { isSubmittedInput } from '@backend/features/agent-state/replies'

// The recycled-ppid guard: Windows reuses pids aggressively, so a long-lived
// process can claim a ppid that NOW belongs to a brand-new pane shell — and a
// stray agent running anywhere on the machine reads as "this pane's agent".
// The board's typed-launch handoff trusts that verdict with user prose, which
// is why an impossible edge (child older than its parent) must never be
// followed. Found live on 2026-07-16: a running aider grafted onto fresh
// queue-launched panes exactly this way.

const row = (pid: number, ppid: number, startedAt?: number): ProcRow => ({
  pid,
  ppid,
  base: 'x',
  cmd: 'x',
  ...(startedAt !== undefined ? { startedAt } : {})
})

describe('isRecycledPpidEdge', () => {
  it('drops the impossible edge: the child predates its claimed parent', () => {
    const child = row(200, 100, 1_000_000) // created long ago
    const parent = row(100, 1, 2_000_000) // the pid's NEW owner, created later
    expect(isRecycledPpidEdge(child, parent)).toBe(true)
  })

  it('keeps a real chain (parent predates child)', () => {
    expect(isRecycledPpidEdge(row(200, 100, 2_000_000), row(100, 1, 1_000_000))).toBe(false)
  })

  it('tolerates clock rounding inside the slack', () => {
    expect(isRecycledPpidEdge(row(200, 100, 1_000_000), row(100, 1, 1_000_300))).toBe(false)
  })

  it('fails OPEN when either timestamp is missing (POSIX rows)', () => {
    expect(isRecycledPpidEdge(row(200, 100), row(100, 1, 1_000_000))).toBe(false)
    expect(isRecycledPpidEdge(row(200, 100, 1_000_000), row(100, 1))).toBe(false)
  })
})

// F001 — a BRACKETED paste is composing, not answering.
//
// `isSubmittedInput` (replies.ts:82) has always bailed on an ESC-introduced chunk, naming
// bracketed paste in its comment. `countSubmittedLines` did not, and both are called from the
// same block in the two write paths (pty.service.ts and the daemon's session.ts twin). So a
// 2,000-line paste — a log tail, a stack trace — armed 2,000 command-starts. The damage does
// not decay: `pendingSubmits` only resets at `<= 1`, so every later prompt in that pane bought
// a full process-table listing (700-1100ms of CIM on Windows, by agent-proc's own measurement),
// and `pendingStarts` kept `commandActive` true, which is the exact flag `acceptWorktree` reads
// to refuse letting a background `git` relabel the pane's cwd.
describe('countSubmittedLines', () => {
  const BRACKET_ON = '\x1b[200~'
  const BRACKET_OFF = '\x1b[201~'

  it('counts bare submitted lines', () => {
    expect(countSubmittedLines('one\r\ntwo\nthree\r')).toBe(3)
    expect(countSubmittedLines('a\rb\r')).toBe(2)
    expect(countSubmittedLines('no newline')).toBe(0)
    expect(countSubmittedLines('')).toBe(0)
  })

  it('counts ZERO inside a bracketed paste, however many CRs it carries', () => {
    expect(countSubmittedLines(`${BRACKET_ON}a\rb\rc${BRACKET_OFF}`)).toBe(0)
    // The shape that broke it: a big paste, every line CR-separated by sanitizePaste.
    const big = `${BRACKET_ON}${'line\r'.repeat(2000)}${BRACKET_OFF}`
    expect(countSubmittedLines(big)).toBe(0)
  })

  it('agrees with isSubmittedInput on the ESC rule', () => {
    // The two are read together at the same call site; if they ever disagree again, the
    // cost model and the cwd lane disagree with the attention latch about the same bytes.
    const paste = `${BRACKET_ON}a\rb${BRACKET_OFF}`
    expect(isSubmittedInput(paste)).toBe(false)
    expect(countSubmittedLines(paste)).toBe(0)
    expect(isSubmittedInput('a\r')).toBe(true)
    expect(countSubmittedLines('a\r')).toBe(1)
  })
})
