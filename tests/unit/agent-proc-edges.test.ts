import { describe, expect, it } from 'vitest'
import { isRecycledPpidEdge, type ProcRow } from '@backend/features/agent-state/agent-proc'

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
