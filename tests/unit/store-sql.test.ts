import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SessionStore } from '@backend/features/workspace/session-store'
import { SettingsStore } from '@backend/features/workspace/settings-store'
import { requireNative } from '@backend/platform/native-require'
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
//
// It is answered in TWO tiers, because only one of them can run here:
//
//   · the STRUCTURAL half — the three column lists must name the same columns — is pure text
//     over the source, needs no database, and runs on every host. It is the half that
//     actually catches the silent drop, so it is never skipped.
//   · the BEHAVIOURAL half — open a real file, write, close, reopen, read — needs the
//     compiled better-sqlite3 addon, which the unit tier essentially never has (see
//     `hasNodeAbiSqlite`). It is gated, and the Electron-boot gates carry it for real:
//     migrate-smoke round-trips seeded panes across a migration, cwd-smoke and remote-smoke
//     each read a persisted pane (remote included) back off disk under the real runtime.

/**
 * Can the unit tier actually open a database?
 *
 * Almost never — and by design, not by accident. better-sqlite3 is ABI-bound and NOTHING in
 * this repo builds it for plain Node, which is what vitest runs under:
 *
 *   · `postinstall` runs `electron-builder install-app-deps`  -> ELECTRON ABI
 *   · .github/actions/electron-native-rebuild runs node-gyp `--runtime=electron` -> ELECTRON ABI
 *   · the `verify` job installs with `npm ci --ignore-scripts` -> no binary at all
 *
 * So this file's DB half fails two different ways off a dev box: "Could not locate the
 * bindings file" in CI (nothing compiled), and "compiled against a different Node.js version
 * ... NODE_MODULE_VERSION 140 ... requires 137" on a correctly-provisioned dev machine
 * (compiled for Electron). It passed for exactly one person because their shell exports
 * MOGGING_HELPER_NATIVES — the daemon-spawn variable — which sends `requireNative` to the
 * INSTALLED app's Node-ABI copy. That is a leaked env var, not a working test environment.
 *
 * Probed through `requireNative`, the same seam the stores use, so the probe and the code
 * under test can never disagree about which binary they would get. A real open, not
 * `existsSync`: an ABI-mismatched binary is present and still unloadable.
 */
const hasNodeAbiSqlite = ((): boolean => {
  try {
    const Database = requireNative<typeof import('better-sqlite3')>('better-sqlite3')
    const probe = new Database(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

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
  // Launch intent spans TWO columns (agent_id + launch_intent), so it is exactly the shape
  // of field this file exists to catch: map it correctly, forget one of the three column
  // lists, and the pane comes back having lost the profile it ran under.
  launch: {
    v: 1,
    agentId: 'claude',
    cwd: 'C:\\repos\\alpha',
    profileId: 'cmain',
    configDir: 'C:\\Users\\p\\.claude-cmain',
    source: 'declared',
    at: 1_700_000_000_400
  },
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

describe.skipIf(!hasNodeAbiSqlite)('SessionStore panes', () => {
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

})

// The STRUCTURAL half — never skipped. This is the half that catches the silent drop, and it
// is pure text over the source, so it answers on a runner with no compiled addon at all.
describe('the pane column lists agree (no database needed)', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../../src/backend/features/workspace/session-store.ts'), 'utf8')
  const select = /const PANE_COLUMNS =\s*\n?\s*'([^']+)'/.exec(src)
  const insert = /INSERT INTO panes \(([^)]+)\)/.exec(src)
  const values = /VALUES \(([^)]+)\)/.exec(src)

  it('the SELECT and the INSERT name the same columns', () => {
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

  // The UPSERT's third list. `savePanes` on an EXISTING id takes the DO UPDATE branch and
  // touches only the columns named there — so a column left out of it is written once and
  // then frozen forever, which is the same silent drop one write later. This is what the
  // gated 'upserts rather than duplicating' row proves with a real database; asserted here
  // so a runner without the addon still catches it.
  it('the ON CONFLICT update covers every inserted column', () => {
    const update = /ON CONFLICT\(id\) DO UPDATE SET([\s\S]*?)`/.exec(src)
    expect(update, 'the DO UPDATE SET list moved — re-anchor rather than delete').toBeTruthy()

    const assigned = [...update![1].matchAll(/(\w+)\s*=\s*excluded\.(\w+)/g)]
    expect(assigned.length, 'no assignments parsed — the anchor is stale').toBeGreaterThan(0)
    for (const [, target, source] of assigned) {
      expect(source, `${target} is refreshed from the wrong excluded column`).toBe(target)
    }

    const inserted = insert![1].split(',').map((c) => c.trim())
    expect(
      assigned.map(([, target]) => target).sort(),
      'a column missing from DO UPDATE SET is written once and never updated again'
    ).toEqual(inserted.filter((c) => c !== 'id').sort())
  })
})

describe.skipIf(!hasNodeAbiSqlite)('SettingsStore templates', () => {
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
