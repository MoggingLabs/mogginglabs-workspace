import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SessionStore } from '@backend/features/workspace/session-store'
import { SettingsStore } from '@backend/features/workspace/settings-store'
import type { PersistedPane, ProviderMixTemplate } from '@contracts'
import { makeTempDir, removeTempDirs } from './temp-dir'

// THE SQL ROUND TRIP.
//
// tests/unit/session-rows.test.ts already pins the pure `paneToRow`/`rowToPane` mapping. What
// it cannot see is the SQL either side of it: a field can map correctly and still be dropped,
// because the INSERT names one column list and the SELECT names another.
//
// That is the failure this file exists for — add a field, wire the mapping, forget one of the
// two lists, and the round trip loses it silently. Nothing throws; the pane just comes back
// without its remote, or its reported cwd.

const dirs: string[] = []
afterAll(() => removeTempDirs(dirs))
const tempDb = (name: string): string => {
  const d = makeTempDir('store-sql-')
  dirs.push(d)
  return join(d, name)
}

const LOCAL: PersistedPane = {
  id: '103',
  workspaceId: 'default',
  cwd: 'C:\\repos\\alpha',
  reportedCwd: 'C:\\repos\\alpha\\.mogging\\worktrees\\x',
  reportedCwdAt: 1_700_000_000_000,
  command: 'claude',
  scrollback: 'hello\r\nworld',
  cols: 133,
  rows: 41,
  updatedAt: 1_700_000_000_500
}

const REMOTE: PersistedPane = {
  id: '201',
  workspaceId: 'default',
  cwd: '',
  remote: {
    name: 'buildbox',
    host: 'build.example.com',
    user: 'pedro',
    port: 2222,
    platform: 'posix',
    cwd: '/srv/alpha',
    shell: 'bash'
  },
  command: 'codex',
  scrollback: '',
  updatedAt: 1_700_000_001_000
}

describe('SessionStore panes', () => {
  it('round-trips every field of a local pane through SQLite', () => {
    const store = new SessionStore(tempDb('s.db'))
    store.savePanes([LOCAL])
    expect(store.loadPanes()).toEqual([LOCAL])
    store.close()
  })

  // The remote block is 7 columns. Losing one from either list is invisible to the mapping
  // test and turns a remote pane into a local one on restore.
  it('round-trips every field of a REMOTE pane', () => {
    const store = new SessionStore(tempDb('r.db'))
    store.savePanes([REMOTE])
    expect(store.loadPanes()).toEqual([REMOTE])
    store.close()
  })

  it('survives a close and reopen — that is the whole point of persisting', () => {
    const path = tempDb('reopen.db')
    const first = new SessionStore(path)
    first.savePanes([LOCAL, REMOTE])
    first.close()

    const second = new SessionStore(path)
    expect(second.loadPanes()).toEqual([LOCAL, REMOTE])
    second.close()
  })

  it('upserts rather than duplicating on the same id', () => {
    const store = new SessionStore(tempDb('u.db'))
    store.savePanes([LOCAL])
    store.savePanes([{ ...LOCAL, command: 'codex' }])
    const back = store.loadPanes()
    expect(back).toHaveLength(1)
    expect(back[0]?.command).toBe('codex')
    store.close()
  })

  it('is empty on a fresh database rather than throwing', () => {
    const store = new SessionStore(tempDb('fresh.db'))
    expect(store.loadPanes()).toEqual([])
    store.close()
  })

  // The structural half: the two column lists must name the same fields. A mismatch here is
  // exactly the silent-drop bug, and it is checkable without a database.
  it('the SELECT and the INSERT name the same columns', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../../src/backend/features/workspace/session-store.ts'),
      'utf8'
    )
    const select = /const PANE_COLUMNS =\s*\n?\s*'([^']+)'/.exec(src)
    const insert = /INSERT INTO panes \(([^)]+)\)/.exec(src)
    const values = /VALUES \(([^)]+)\)/.exec(src)
    expect(select, 'PANE_COLUMNS moved — re-anchor rather than delete').toBeTruthy()
    expect(insert, 'PANE_UPSERT moved').toBeTruthy()
    expect(values, 'the VALUES list moved').toBeTruthy()

    const selected = select![1].split(',').map((c) => c.trim().split(/\s+AS\s+/i)[0]!.trim())
    const inserted = insert![1].split(',').map((c) => c.trim())
    const bound = values![1].split(',').map((c) => c.trim())

    expect(selected.slice().sort(), 'a column the INSERT writes but the SELECT never reads is lost on restore').toEqual(
      inserted.slice().sort()
    )
    expect(bound.length, 'every inserted column needs a bound parameter').toBe(inserted.length)
  })
})

describe('SettingsStore templates', () => {
  const TEMPLATE: ProviderMixTemplate = {
    id: 't1',
    name: 'Two claude',
    mix: [{ provider: 'claude', count: 2 }]
  } as ProviderMixTemplate

  it('round-trips a saved template', () => {
    const store = new SettingsStore(tempDb('t.db'))
    store.saveTemplate(TEMPLATE)
    expect(store.loadTemplates()).toEqual([TEMPLATE])
    store.close?.()
  })

  it('upserts on the same id instead of duplicating', () => {
    const store = new SettingsStore(tempDb('t2.db'))
    store.saveTemplate(TEMPLATE)
    store.saveTemplate({ ...TEMPLATE, name: 'Renamed' })
    const back = store.loadTemplates()
    expect(back).toHaveLength(1)
    expect(back[0]?.name).toBe('Renamed')
    store.close?.()
  })

  it('removes exactly the one asked for', () => {
    const store = new SettingsStore(tempDb('t3.db'))
    store.saveTemplate(TEMPLATE)
    store.saveTemplate({ ...TEMPLATE, id: 't2', name: 'Other' })
    store.removeTemplate('t1')
    expect(store.loadTemplates().map((t) => t.id)).toEqual(['t2'])
    store.close?.()
  })

  it('is empty on a fresh database', () => {
    const store = new SettingsStore(tempDb('t4.db'))
    expect(store.loadTemplates()).toEqual([])
    store.close?.()
  })
})
