import { describe, expect, it } from 'vitest'
import { bootIntentsFor, paneIdForSlot, type StoredSnapshot } from '../../src/main/session-restore-rules'
import type { WorkspaceState, WorkspaceStateMeta } from '@contracts'

// The boot-restore exact-resume intersection (audit 2026-08-02: the ordinary app-boot
// restore typed bare `--resume` — the picker — because nothing armed the snapshot's
// session ids on that path). The intersection is the safety half: shrink-hold keeps OLD
// workspace sets in the snapshot on purpose, and a stale intent must never name a
// session for a pane id that now belongs to something else.

const meta = (over: Partial<WorkspaceStateMeta> = {}): WorkspaceStateMeta =>
  ({
    id: 'ws-1',
    name: 'W',
    color: '#123456',
    cwd: 'C:\\repo',
    ordinal: 1,
    paneCount: 2,
    assignments: ['claude', ''],
    ...over
  }) as WorkspaceStateMeta

const session = { provider: 'claude', file: 'C:\\home\\projects\\x\\11111111-2222-3333-4444-555555555555.jsonl', sessionId: '11111111-2222-3333-4444-555555555555' }

const snapshot = (workspaces: StoredSnapshot['workspaces']): StoredSnapshot => ({
  savedAt: 1,
  activeId: 'ws-1',
  workspaces
})

const state = (workspaces: WorkspaceStateMeta[]): WorkspaceState =>
  ({ workspaces, activeId: workspaces[0]?.id ?? null }) as WorkspaceState

describe('paneIdForSlot', () => {
  it('follows ordinal*100+slot, and a moved pane keeps its own id', () => {
    expect(paneIdForSlot(meta({ ordinal: 3 }), 2)).toBe(302)
    expect(paneIdForSlot(meta({ ordinal: 3, paneIds: [777, null] }), 1)).toBe(777)
    expect(paneIdForSlot(meta({ ordinal: 3, paneIds: [777, null] }), 2)).toBe(302)
  })
})

describe('bootIntentsFor', () => {
  it('arms a slot whose workspace, provider and pane id all agree', () => {
    const snap = snapshot([{ ...meta(), paneSessions: [session, null] }])
    expect(bootIntentsFor(snap, state([meta()]))).toEqual([{ paneId: 101, session }])
  })

  it('a workspace missing from the restored state arms nothing (stale shrink-hold set)', () => {
    const snap = snapshot([{ ...meta({ id: 'ws-gone' }), paneSessions: [session] }])
    expect(bootIntentsFor(snap, state([meta()]))).toEqual([])
  })

  it('a slot whose assignment changed provider arms nothing', () => {
    const snap = snapshot([{ ...meta(), paneSessions: [session, null] }])
    expect(bootIntentsFor(snap, state([meta({ assignments: ['codex', ''] })]))).toEqual([])
  })

  it('a slot whose pane id resolution drifted arms nothing', () => {
    const snap = snapshot([{ ...meta(), paneSessions: [session, null] }])
    expect(bootIntentsFor(snap, state([meta({ ordinal: 2 })]))).toEqual([])
  })

  it('moved panes match on their OWN id, both sides', () => {
    const moved = { ordinal: 1, paneIds: [777, null] as (number | null)[] }
    const snap = snapshot([{ ...meta(moved), paneSessions: [session, null] }])
    expect(bootIntentsFor(snap, state([meta(moved)]))).toEqual([{ paneId: 777, session }])
  })

  it('null slots and empty paneSessions arm nothing', () => {
    const snap = snapshot([{ ...meta(), paneSessions: [null, null] }, { ...meta({ id: 'ws-2', ordinal: 2 }) }])
    expect(bootIntentsFor(snap, state([meta(), meta({ id: 'ws-2', ordinal: 2 })]))).toEqual([])
  })
})
