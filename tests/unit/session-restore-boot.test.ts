import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootIntentsFor, paneIdForSlot, type StoredSnapshot } from '../../src/main/session-restore-rules'
import { WorkspaceChannels, type WorkspaceState, type WorkspaceStateMeta } from '@contracts'

// The four Electron edges session-restore.ts touches, stubbed so the REAL module can be
// driven end to end: the IPC door, the settings store it persists through, the context
// monitor's locked-log lookup, and the fault port. Hoisted because vi.mock factories run
// before the file's own imports.
const edges = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  settings: new Map<string, string>(),
  logs: new Map<number, { provider: string; file: string }>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      edges.handlers.set(channel, fn)
    }
  }
}))
vi.mock('../../src/main/app-settings', () => ({
  getSettingsStore: () => ({
    getSetting: (k: string) => edges.settings.get(k) ?? null,
    setSetting: (k: string, v: string) => {
      edges.settings.set(k, v)
    }
  })
}))
vi.mock('../../src/main/context', () => ({ paneSessionLog: (paneId: number) => edges.logs.get(paneId) }))
vi.mock('../../src/main/assigned-sessions', () => ({ assignedSessionFor: () => undefined }))
vi.mock('../../src/main/fault-port', () => ({ maybeFault: async () => {} }))
vi.mock('@backend/features/agents', () => ({
  resumeSessionIdFromFile: (_provider: string, file: string) =>
    file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '')
}))

import {
  lastSessionSnapshotForSmoke,
  noteWorkspaceSave,
  registerSessionRestore,
  resumeIntentsForSmoke
} from '../../src/main/session-restore'

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

// ---------------------------------------------------------------------------------------
// The MIRROR-SAVE HOLD, driven through the real module.
//
// Two defects, one line. (1) The boot restore fires a debounced save ~400ms after launch,
// when the monitor holds no locked log for any pane — so paneSessionsFor answered undefined
// and the rewrite ERASED the exact-session ids the "Restore last working session" card
// exists to carry, degrading the promise to a bare `--resume` picker. (2) The hold that
// fixes it must not travel by SLOT INDEX: `paneIds` re-lets a slot to a pane dragged in
// from another workspace, and the readers resolve a stored array through the meta it rides,
// so a positional graft arms one user's conversation inside somebody else's terminal.
// Restoring ANOTHER pane's session is worse than restoring none, so refusal is the failure
// mode: a pane that left takes its session with it and the slot holds nothing.

const UUID_A = '11111111-2222-3333-4444-555555555555'
const logFor = (uuid: string): { provider: string; file: string } => ({
  provider: 'claude',
  file: `C:\\home\\projects\\x\\${uuid}.jsonl`
})

const ws = (over: Partial<WorkspaceStateMeta> = {}): WorkspaceStateMeta =>
  ({
    id: 'ws-1',
    name: 'W',
    color: '#111111',
    cwd: 'C:\\repo',
    ordinal: 1,
    paneCount: 2,
    assignments: ['claude', ''],
    ...over
  }) as WorkspaceStateMeta

/** Drive the real workspace:restoreSession door and read what it armed. */
const armedIntents = async (): Promise<Array<{ paneId: number; sessionId?: string }>> => {
  const handler = edges.handlers.get(WorkspaceChannels.restoreSession)
  expect(handler).toBeTypeOf('function')
  await handler!({}, {})
  return resumeIntentsForSmoke().map(({ paneId, sessionId }) => ({ paneId, sessionId }))
}

describe('noteWorkspaceSave — the mirror save holds what it cannot re-derive', () => {
  beforeEach(() => {
    edges.settings.clear()
    edges.logs.clear()
    registerSessionRestore()
  })

  it('a BLIND save (no locked logs) keeps the sessions an earlier save recorded', async () => {
    edges.logs.set(101, logFor(UUID_A))
    noteWorkspaceSave(null, state([ws()]))
    expect(lastSessionSnapshotForSmoke()?.workspaces[0].paneSessions?.[0]?.sessionId).toBe(UUID_A)

    // The monitor goes blind (boot: no pane has prompted yet) and the SAME set is re-saved,
    // RECOLOURED — the recolour is the anti-vacuity witness, proving this save really did
    // rewrite the row, so "the session is still there" cannot be the untouched older one.
    edges.logs.clear()
    noteWorkspaceSave(state([ws()]), state([ws({ color: '#abcdef' })]))
    const stored = lastSessionSnapshotForSmoke()?.workspaces[0]
    expect(stored?.color).toBe('#abcdef')
    expect(stored?.paneSessions?.[0]?.sessionId).toBe(UUID_A)
    expect(await armedIntents()).toEqual([{ paneId: 101, sessionId: UUID_A }])
  })

  it('refuses to graft a held session onto a pane that MOVED IN to the slot', async () => {
    edges.logs.set(101, logFor(UUID_A))
    noteWorkspaceSave(null, state([ws()]))

    // Pane 205 is dragged in from another workspace and now holds slot 1; pane 101 is gone.
    edges.logs.clear()
    noteWorkspaceSave(state([ws()]), state([ws({ color: '#abcdef', paneIds: [205, null] })]))
    const stored = lastSessionSnapshotForSmoke()?.workspaces[0]
    expect(stored?.color).toBe('#abcdef') // the save landed — the assertion below is not vacuous
    expect(stored?.paneSessions).toBeUndefined()
    expect(await armedIntents()).toEqual([]) // never 205 wearing 101's conversation
  })

  it('follows a pane SHUFFLED to another slot inside the same workspace', async () => {
    // Ordinal 2, so the formula ids (201/202/203) can never collide with the moved pane 103.
    const shape = { id: 'ws-2', ordinal: 2, paneCount: 3, assignments: ['claude', 'claude', 'claude'] }
    edges.logs.set(103, logFor(UUID_A))
    noteWorkspaceSave(null, state([ws({ ...shape, paneIds: [103, null, null] })]))
    expect(lastSessionSnapshotForSmoke()?.workspaces[0].paneSessions?.[0]?.sessionId).toBe(UUID_A)

    edges.logs.clear()
    noteWorkspaceSave(
      state([ws({ ...shape, paneIds: [103, null, null] })]),
      state([ws({ ...shape, color: '#abcdef', paneIds: [null, 103, null] })])
    )
    const stored = lastSessionSnapshotForSmoke()?.workspaces[0]
    expect(stored?.color).toBe('#abcdef')
    expect(stored?.paneSessions?.map((s) => s?.sessionId ?? null)).toEqual([null, UUID_A, null])
    // The pane that OWNS the conversation is the one armed — not slot 1's new occupant 201.
    expect(await armedIntents()).toEqual([{ paneId: 103, sessionId: UUID_A }])
  })
})
