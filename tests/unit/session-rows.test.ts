import { describe, expect, it } from 'vitest'
import type { PersistedPane } from '@contracts'
import { LAUNCH_INTENT_VERSION, REMOTE_READY_OSC } from '@contracts'
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
  launch: {
    v: LAUNCH_INTENT_VERSION,
    agentId: 'claude',
    cwd: 'C:\\repos\\alpha',
    profileId: 'cmain',
    configDir: 'C:\\Users\\p\\.claude-cmain',
    source: 'declared',
    at: 1_700_000_000_400
  },
  scrollback: 'hello\n',
  cols: 133,
  rows: 41,
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

  // A pane that ran an agent under a profile must not come back as an anonymous shell. The
  // remote guard above is the precedent; these are its twin for agent panes, and the reason
  // `agent_id` is its own column rather than a field inside the blob.
  it('carries launch intent through the row and back', () => {
    const row = paneToRow(LOCAL)
    expect(row.agentId).toBe('claude')
    expect(JSON.parse(row.launchIntent!)).toEqual(LOCAL.launch)
    expect(rowToPane(row)?.launch).toEqual(LOCAL.launch)
    expect(rowToPane(row)?.launchDegraded).toBeUndefined()
  })

  it('never writes an agent id without an intent beside it', () => {
    // A write-side violation would manufacture the exact torn row the read side refuses.
    const shell = paneToRow({ ...LOCAL, launch: undefined })
    expect(shell.agentId).toBeNull()
    expect(shell.launchIntent).toBeNull()
  })

  it.each([
    ['a missing blob', { launchIntent: null }],
    ['an unparseable blob', { launchIntent: '{not json' }],
    ['a blob from a newer build', { launchIntent: JSON.stringify({ ...LOCAL.launch, v: 99 }) }],
    ['a blob naming a different agent', { launchIntent: JSON.stringify({ ...LOCAL.launch, agentId: 'codex' }) }]
  ])('degrades VISIBLY on %s rather than restoring a plain shell', (_label, patch) => {
    const pane = rowToPane({ ...paneToRow(LOCAL), ...patch })
    expect(pane).not.toBeNull()
    expect(pane?.launchDegraded).toBe(true)
    // It still says WHAT it was, so the pane can offer to relaunch instead of going quiet.
    expect(pane?.launch?.agentId).toBe('claude')
    // ...and the scrollback is untouched: nothing overwrites the session that was lost.
    expect(pane?.scrollback).toBe(LOCAL.scrollback)
  })

  // Rows written before the intent columns existed. THE bug: the shipped resume matcher took
  // the first token of this command, which is `cd` for every command the app ever built.
  it('derives intent from a legacy command string when both intent columns are empty', () => {
    const legacy = {
      ...paneToRow(LOCAL),
      agentId: null,
      launchIntent: null,
      command: 'cd /d "C:\\repos\\alpha" && set "CLAUDE_CONFIG_DIR=C:\\Users\\p\\.claude-cmain" && claude --settings C:\\gen.json'
    }
    expect(rowToPane(legacy)?.launch).toMatchObject({
      agentId: 'claude',
      cwd: 'C:\\repos\\alpha',
      configDir: 'C:\\Users\\p\\.claude-cmain',
      source: 'legacy'
    })
    expect(rowToPane(legacy)?.launchDegraded).toBeUndefined()
  })

  it('leaves a legacy plain-shell row without intent, and not degraded', () => {
    const legacy = { ...paneToRow(LOCAL), agentId: null, launchIntent: null, command: 'npm run dev' }
    const pane = rowToPane(legacy)
    expect(pane?.launch).toBeUndefined()
    expect(pane?.launchDegraded).toBeUndefined()
  })

  it('does not re-derive once real columns exist — the derivation self-extinguishes', () => {
    const row = { ...paneToRow(LOCAL), command: 'cd /d "C:\\elsewhere" && codex' }
    expect(rowToPane(row)?.launch).toEqual(LOCAL.launch)
  })

  it('drops an unknown persisted shell dialect rather than inventing one', () => {
    const pane = rowToPane({ ...paneToRow(REMOTE), remoteShell: 'tcsh' })
    expect(pane?.remote?.shell).toBeUndefined()
  })

  it('restores without dims on a pre-migration row (grid columns null)', () => {
    const pane = rowToPane({ ...paneToRow(LOCAL), gridCols: null, gridRows: null })
    expect(pane?.cols).toBeUndefined()
    expect(pane?.rows).toBeUndefined()
  })

  it('drops a corrupt or torn grid whole rather than restoring half a size', () => {
    // Below the pty floors (2 cols / 1 row) — the values node-pty would throw on.
    expect(rowToPane({ ...paneToRow(LOCAL), gridCols: 0 })?.cols).toBeUndefined()
    expect(rowToPane({ ...paneToRow(LOCAL), gridRows: -3 })?.rows).toBeUndefined()
    // A torn pair (cols without rows) falls back together: half a grid is not a size.
    const torn = rowToPane({ ...paneToRow(LOCAL), gridRows: null })
    expect(torn?.cols).toBeUndefined()
    expect(torn?.rows).toBeUndefined()
    // Non-integer dims never reach node-pty.
    expect(rowToPane({ ...paneToRow(LOCAL), gridCols: 80.5 })?.cols).toBeUndefined()
  })

  it('caps the persisted scrollback tail at PERSISTED_SCROLLBACK_CHARS', () => {
    const long = 'x'.repeat(PERSISTED_SCROLLBACK_CHARS + 5000)
    const row = paneToRow({ ...LOCAL, scrollback: long })
    expect(row.scrollback.length).toBe(PERSISTED_SCROLLBACK_CHARS)
    expect(row.scrollback.endsWith('x')).toBe(true)
  })
})

describe('the remote-readiness marker never rides in persisted history', () => {
  // REMOTE_READY_OSC is how a remote shell says "I am past SSH auth". It is ordinary pty
  // output, so it lands in scrollback like anything else — and on a COLD-START restore the
  // replay feeds it back through the pane's parser, which declares a brand-new,
  // unauthenticated ssh session ready. The resume lineup then types into a password prompt.
  //
  // The audit's recommended fix was the replayCopyGraceUntil window. That does not work here:
  // it arms in the spawn `.then()`, which runs AFTER the replay has already fired, and the
  // adjacent scrub only runs for replay === 'reset', which a cold-start restore is not.
  const withMarker = `some history\n${REMOTE_READY_OSC}more history\n`

  it('is stripped on the way OUT', () => {
    const row = paneToRow({ ...LOCAL, scrollback: withMarker })
    expect(row.scrollback).not.toContain(REMOTE_READY_OSC)
    expect(row.scrollback, 'only the marker goes').toContain('more history')
  })

  // A write-side fix alone protects nobody who is upgrading: every row written by every
  // previous build already holds the marker.
  it('is stripped on the way IN, for rows older builds wrote', () => {
    const pane = rowToPane({ ...paneToRow(LOCAL), scrollback: withMarker })
    expect(pane, 'the row must still map to a pane').toBeTruthy()
    expect(pane?.scrollback).not.toContain(REMOTE_READY_OSC)
    expect(pane?.scrollback).toContain('more history')
  })

  it('strips every occurrence, not just the first', () => {
    const many = `a${REMOTE_READY_OSC}b${REMOTE_READY_OSC}c`
    expect(rowToPane({ ...paneToRow(LOCAL), scrollback: many })?.scrollback).toBe('abc')
  })

  it('leaves ordinary history untouched', () => {
    const plain = 'no markers here\n\x1b[32mgreen\x1b[m\n'
    expect(rowToPane({ ...paneToRow(LOCAL), scrollback: plain })?.scrollback).toBe(plain)
  })

  it('strips BEFORE the length cap, so markers do not evict real history', () => {
    // Real history that FITS the cap on its own, padded with markers until it does not. Cap
    // first and the head of the history is trimmed to make room for bytes that are about to be
    // deleted anyway; strip first and all of it survives.
    const real = 'H'.repeat(PERSISTED_SCROLLBACK_CHARS - 10)
    const marker = REMOTE_READY_OSC.repeat(200)
    const row = paneToRow({ ...LOCAL, scrollback: marker + real })
    expect(row.scrollback).not.toContain(REMOTE_READY_OSC)
    expect(row.scrollback.length, 'the cap must count history, not markers').toBe(real.length)
  })
})
