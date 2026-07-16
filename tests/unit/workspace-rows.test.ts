import { describe, expect, it } from 'vitest'
import type { WorkspaceStateMeta } from '@contracts'
import {
  parseJsonCell,
  workspaceMetaToRow,
  workspaceRowToMeta
} from '@backend/features/workspace/workspace-rows'

// The mapping this file tests is the one that silently DROPPED WorkspaceStateMeta.paneIds
// for its whole life: the contract carried it, the renderer sent it, restore consumed it,
// and the store's hand-written column list simply never included it — so a pane moved
// between workspaces lost its daemon session on every app restart. The full-meta
// round-trip below is the structural bite: the NEXT field someone adds to the contract
// but forgets in the mapping fails here, not in a user's restart.

/** Every optional field populated — the shape the round-trip must preserve whole. */
const FULL_META: WorkspaceStateMeta = {
  id: 'ws-a',
  name: 'Alpha',
  color: '#2dd4bf',
  cwd: 'C:\\repos\\alpha',
  ordinal: 2,
  paneCount: 3,
  layout: '{"v":2,"dir":"row"}',
  assignments: ['claude', 'shell', 'codex'],
  paneCwds: ['C:\\repos\\alpha', null, 'C:\\repos\\alpha\\.mogging\\worktrees\\x'],
  roles: [null, 'reviewer', null],
  remotes: [null, { hostId: 'h1', name: 'buildbox', cwd: '/srv/alpha' }, null],
  profileIds: ['p1', null, null],
  paneIds: [null, 103, null]
}

describe('workspace row mapping', () => {
  it('round-trips a fully-populated meta, field for field', () => {
    expect(workspaceRowToMeta(workspaceMetaToRow(FULL_META))).toEqual(FULL_META)
  })

  it('round-trips paneIds — the moved-pane session key (the dropped field)', () => {
    const meta = workspaceRowToMeta(workspaceMetaToRow(FULL_META))
    expect(meta.paneIds).toEqual([null, 103, null])
  })

  it('persists absent optional fields as NULL cells (untouched workspaces stay byte-stable)', () => {
    const bare: WorkspaceStateMeta = { id: 'w', name: 'n', color: '#fff', cwd: '', ordinal: 0, paneCount: 1 }
    const row = workspaceMetaToRow(bare)
    expect(row.assignments).toBeNull()
    expect(row.paneIds).toBeNull()
    expect(row.layoutTree).toBeNull()
    expect(workspaceRowToMeta(row)).toEqual({ ...bare, layout: undefined })
  })

  it('degrades one corrupt cell to that FIELD, never the row', () => {
    const row = workspaceMetaToRow(FULL_META)
    const meta = workspaceRowToMeta({ ...row, paneIds: '{not json' })
    expect(meta.paneIds).toBeUndefined()
    expect(meta.id).toBe('ws-a')
    expect(meta.roles).toEqual(FULL_META.roles)
  })
})

describe('parseJsonCell', () => {
  it('returns undefined for null, empty, and junk without throwing', () => {
    expect(parseJsonCell(null)).toBeUndefined()
    expect(parseJsonCell('')).toBeUndefined()
    expect(parseJsonCell('{oops')).toBeUndefined()
  })
})
