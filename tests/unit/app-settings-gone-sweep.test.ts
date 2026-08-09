import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readGrant, sanitizeGrant, writeGrant } from '@backend/features/integrations/grant-store'
import type { AgentConfigScope } from '@contracts'

// app-settings.ts is main-process wiring, so `electron` has to be answered before the module
// graph loads. Nothing under test touches it — the sweep is called from inside the saveState
// handler, never at module scope — so an inert stub is the whole of it.
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  ipcMain: { handle: () => {} }
}))

import { sweepGoneWorkspaces, type GoneSweepStore } from '../../src/main/app-settings'

// THE DEFERRED GRANT SWEEP (F016).
//
// A workspace absent from a save is NOT necessarily deleted. `softClose` drops its id from
// `order` — which `list()` reads, and which the saved state mirrors — immediately, while its
// panes stay alive for the ~5s undo window. The sweep used to fire on that first shrinking
// save, so a user's integration grant and agent-config overrides were destroyed DURING the
// grace, and Undo brought the workspace back without them. That is silent data loss on an
// action the UI advertises as undoable.
//
// So: gone once = CANDIDATE (kept). Gone again on a later save = swept. Back before then
// (Undo) = dropped, unswept.

const GONE_CANDIDATES_KEY = 'workspaces.goneCandidates'

/** A SettingsStore stand-in: the real KV semantics (`getSetting` answers null, not
 *  undefined) plus a log of the agent-config removals, which have no read side. */
const makeStore = () => {
  const map = new Map<string, string>()
  const removed: Array<`${AgentConfigScope}:${string}`> = []
  const store = {
    getSetting: (k: string) => map.get(k) ?? null,
    setSetting: (k: string, v: string) => void map.set(k, v),
    removeAgentConfigTarget: (scope: AgentConfigScope, targetId: string) =>
      void removed.push(`${scope}:${targetId}`)
  } satisfies GoneSweepStore
  return { store, map, removed }
}

/** A real, non-default grant — the thing whose survival is the point. */
const grantTo = (store: GoneSweepStore, id: string): void => {
  writeGrant(
    { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) },
    sanitizeGrant(id, { writeTools: 'all', actOrigins: ['github.com'] })
  )
}

const grantOf = (store: GoneSweepStore, id: string) =>
  readGrant({ get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }, id)

const candidates = (map: Map<string, string>): string[] => JSON.parse(map.get(GONE_CANDIDATES_KEY) ?? '[]')

describe('sweepGoneWorkspaces', () => {
  let s: ReturnType<typeof makeStore>
  beforeEach(() => {
    s = makeStore()
  })

  it('leaves a grant alone on the FIRST save that loses the workspace — the undo grace', () => {
    grantTo(s.store, 'ws-b')
    sweepGoneWorkspaces(s.store, ['ws-a', 'ws-b'], ['ws-a'])
    expect(grantOf(s.store, 'ws-b').writeTools, 'swept inside the soft-close grace').toBe('all')
    expect(s.removed).toEqual([])
    expect(candidates(s.map)).toEqual(['ws-b'])
  })

  it('sweeps on a LATER save where the workspace is still gone', () => {
    grantTo(s.store, 'ws-b')
    sweepGoneWorkspaces(s.store, ['ws-a', 'ws-b'], ['ws-a']) // soft close
    sweepGoneWorkspaces(s.store, ['ws-a'], ['ws-a']) // grace elapsed, any later save
    expect(grantOf(s.store, 'ws-b').writeTools).toBe('none')
    expect(grantOf(s.store, 'ws-b').actOrigins).toEqual([])
    expect(s.removed).toEqual(['project:ws-b', 'local:ws-b', 'session:ws-b'])
    expect(candidates(s.map), 'a swept id must not stay a candidate').toEqual([])
  })

  // The candidate set is PERSISTED rather than re-derived from `previous`, and this is why:
  // by the second save `previous` has already lost ws-b, so a previous-diff would sweep a
  // truly-deleted workspace NEVER — the grant would outlive it forever, which is the custody
  // bug the sweep exists to prevent. Pinned by the previousIds above holding only ws-a.
  it('sweeps from the persisted candidate row, not from the previous state', () => {
    grantTo(s.store, 'ws-b')
    s.map.set(GONE_CANDIDATES_KEY, JSON.stringify(['ws-b']))
    sweepGoneWorkspaces(s.store, ['ws-a'], ['ws-a'])
    expect(grantOf(s.store, 'ws-b').writeTools).toBe('none')
  })

  // THE regression, end to end: close, Undo inside the grace, then keep saving.
  it('a candidate that comes back (Undo) is dropped unswept, and stays safe after', () => {
    grantTo(s.store, 'ws-b')
    sweepGoneWorkspaces(s.store, ['ws-a', 'ws-b'], ['ws-a']) // soft close
    sweepGoneWorkspaces(s.store, ['ws-a'], ['ws-a', 'ws-b']) // Undo — ws-b is back
    expect(candidates(s.map), 'a revived workspace must not stay condemned').toEqual([])
    sweepGoneWorkspaces(s.store, ['ws-a', 'ws-b'], ['ws-a', 'ws-b']) // life goes on
    expect(grantOf(s.store, 'ws-b').writeTools, 'Undo did not restore the grant').toBe('all')
    expect(s.removed).toEqual([])
  })

  it('never touches a workspace that is present', () => {
    grantTo(s.store, 'ws-a')
    s.map.set(GONE_CANDIDATES_KEY, JSON.stringify(['ws-a', 'ws-b']))
    sweepGoneWorkspaces(s.store, ['ws-a'], ['ws-a'])
    expect(grantOf(s.store, 'ws-a').writeTools).toBe('all')
    expect(s.removed).toEqual(['project:ws-b', 'local:ws-b', 'session:ws-b'])
  })

  it('records every id lost in one save, without duplicates', () => {
    sweepGoneWorkspaces(s.store, ['ws-a', 'ws-b', 'ws-c'], ['ws-a'])
    expect(candidates(s.map)).toEqual(['ws-b', 'ws-c'])
  })

  // A hand-edited or half-written row must not take the workspace save down with it: the
  // whole sweep is best-effort, and losing a candidate is a stale grant, not a lost save.
  it('starts clean on a corrupt or wrongly-typed candidate row rather than throwing', () => {
    for (const raw of ['not json', '{"nope":1}', '[1,2,3]', 'null']) {
      const fresh = makeStore()
      fresh.map.set(GONE_CANDIDATES_KEY, raw)
      expect(() => sweepGoneWorkspaces(fresh.store, ['ws-a', 'ws-b'], ['ws-a']), raw).not.toThrow()
      expect(fresh.removed, raw).toEqual([])
      expect(candidates(fresh.map), raw).toEqual(['ws-b'])
    }
  })
})
