import { describe, expect, it } from 'vitest'
import type { PersistedPane } from '@contracts'
import {
  PERSISTED_SCROLLBACK_CHARS,
  paneToRow,
  rowToPane
} from '@backend/features/workspace/session-rows'

const LOCAL: PersistedPane = {
  id: '103',
  workspaceId: 'default',
  cwd: 'C:\\repos\\alpha',
  reportedCwd: 'C:\\repos\\alpha\\.mogging\\worktrees\\x',
  reportedCwdAt: 1_700_000_000_000,
  command: 'claude',
  scrollback: 'hello\n',
  updatedAt: 1_700_000_000_500
}

const REMOTE: PersistedPane = {
  id: '201',
  workspaceId: 'default',
  cwd: '',
  remote: { name: 'buildbox', host: 'build.example.com', user: 'pedro', port: 2222, platform: 'posix', cwd: '/srv/alpha', shell: 'bash' },
  command: 'codex',
  scrollback: '',
  updatedAt: 1_700_000_001_000
}

describe('session pane row mapping', () => {
  it('round-trips a local pane', () => {
    expect(rowToPane(paneToRow(LOCAL))).toEqual(LOCAL)
  })

  it('round-trips a remote pane — connection pointer, remote cwd, and shell dialect intact', () => {
    expect(rowToPane(paneToRow(REMOTE))).toEqual(REMOTE)
  })

  it('fails CLOSED on a partial/corrupt remote row instead of restoring a local shell', () => {
    const row = paneToRow(REMOTE)
    // A row that lost its platform (or host) is not restorable as the SSH pane it was —
    // and restoring its launch command into a LOCAL shell is the failure this guards.
    expect(rowToPane({ ...row, remotePlatform: null, remoteHost: null })).toBeNull()
  })

  it('drops an unknown persisted shell dialect rather than inventing one', () => {
    const pane = rowToPane({ ...paneToRow(REMOTE), remoteShell: 'tcsh' })
    expect(pane?.remote?.shell).toBeUndefined()
  })

  it('caps the persisted scrollback tail at PERSISTED_SCROLLBACK_CHARS', () => {
    const long = 'x'.repeat(PERSISTED_SCROLLBACK_CHARS + 5000)
    const row = paneToRow({ ...LOCAL, scrollback: long })
    expect(row.scrollback.length).toBe(PERSISTED_SCROLLBACK_CHARS)
    expect(row.scrollback.endsWith('x')).toBe(true)
  })
})
