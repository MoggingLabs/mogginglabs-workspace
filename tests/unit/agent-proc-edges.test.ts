import { describe, expect, it } from 'vitest'
import { isRecycledPpidEdge, parseEtimeMs, type ProcRow } from '@backend/features/agent-state/agent-proc'

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

// `ps` etime -> startedAt is what gives POSIX rows creation-time evidence at all —
// both for the recycled-ppid guard above and for the context watch's sinceMs floor.
describe('parseEtimeMs', () => {
  it('parses every documented shape ([[dd-]hh:]mm:ss)', () => {
    expect(parseEtimeMs('00:05')).toBe(5_000)
    expect(parseEtimeMs('12:34')).toBe((12 * 60 + 34) * 1000)
    expect(parseEtimeMs('3:02:01')).toBe(((3 * 60 + 2) * 60 + 1) * 1000)
    expect(parseEtimeMs('2-03:04:05')).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000)
  })

  it('yields undefined for foreign shapes (a defunct row prints "-")', () => {
    expect(parseEtimeMs('-')).toBeUndefined()
    expect(parseEtimeMs('')).toBeUndefined()
    expect(parseEtimeMs('123')).toBeUndefined()
  })
})
