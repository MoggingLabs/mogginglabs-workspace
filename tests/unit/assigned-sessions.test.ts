import { describe, expect, it, beforeEach } from 'vitest'
import {
  SESSION_ID_RE,
  adoptAssignedSession,
  assignedSessionFor,
  assignedSessionsForSmoke,
  forgetAssignedSession,
  newClaudeSessionId,
  rememberAssignedSession
} from '../../src/main/assigned-sessions'
import { bodyWithoutComments, sourceOf } from './source-body'

// Identity by ASSIGNMENT (`claude --session-id <uuid>`): the app names a pane's session
// before the CLI starts, instead of recognising it afterwards from transcript birth
// times. The one thing that world can break which the old one could not is a SHARED id —
// two live claude processes appending to one transcript — so the uniqueness guard and the
// release-on-dispose that keeps it finite are what this file holds.

function clear(): void {
  for (const { paneId } of assignedSessionsForSmoke()) forgetAssignedSession(paneId)
}

describe('assigned session ids', () => {
  beforeEach(clear)

  it('mints a uuid claude will accept', () => {
    expect(newClaudeSessionId(1)).toMatch(SESSION_ID_RE)
  })

  it('never hands a pane an id another LIVE pane holds', () => {
    // The guard is a set membership, so prove it against the whole live map rather than
    // one neighbour: every id in play must be distinct.
    const ids = new Set<string>()
    for (let paneId = 1; paneId <= 50; paneId++) {
      const id = newClaudeSessionId(paneId)
      expect(ids.has(id), 'a live id was served twice').toBe(false)
      ids.add(id)
      rememberAssignedSession(paneId, id)
    }
    expect(assignedSessionsForSmoke()).toHaveLength(50)
  })

  it('lets a pane REPLACE its own id — a relaunch is a new session, not a collision', () => {
    const first = newClaudeSessionId(7)
    rememberAssignedSession(7, first)
    const second = newClaudeSessionId(7)
    rememberAssignedSession(7, second)
    expect(assignedSessionFor(7)).toBe(second)
    expect(assignedSessionsForSmoke()).toHaveLength(1)
  })

  it('releases on dispose, so the guard stays finite over a long app run', () => {
    rememberAssignedSession(3, newClaudeSessionId(3))
    forgetAssignedSession(3)
    expect(assignedSessionFor(3)).toBeUndefined()
    expect(assignedSessionsForSmoke()).toHaveLength(0)
  })

  it('adopting from durable storage never overwrites what this run assigned', () => {
    // Restore seeds ids the app forgot; a pane that already relaunched this run has a
    // FRESHER truth, and the stale manifest value must not win.
    const live = newClaudeSessionId(5)
    rememberAssignedSession(5, live)
    adoptAssignedSession(5, '00000000-0000-4000-8000-000000000000')
    expect(assignedSessionFor(5)).toBe(live)

    adoptAssignedSession(6, '00000000-0000-4000-8000-000000000001')
    expect(assignedSessionFor(6)).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('recognises a transcript name and rejects anything else', () => {
    expect(SESSION_ID_RE.test('4f1d2b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(true)
    expect(SESSION_ID_RE.test('not-a-uuid')).toBe(false)
    expect(SESSION_ID_RE.test('4f1d2b3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.jsonl')).toBe(false)
  })
})

describe('the launch path spends the id it assigned', () => {
  const body = bodyWithoutComments(
    sourceOf('src/main/agents.ts'),
    'ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest)'
  )

  it('assigns only to a FRESH claude, and only when the flag is proven', () => {
    // A resume already names its id; a claude too old for the flag would EXIT on it.
    expect(body).toMatch(/claudeSupportsSessionId\(\)/)
    expect(body).toMatch(/req\.agentId === 'claude' &&\s*!resumeFlag &&\s*!resumeSessionId/)
  })

  it('puts --session-id in the command whenever one was minted', () => {
    expect(body).toMatch(/freshSessionId \? \['--session-id', freshSessionId\] : \[\]/)
  })

  it('resumes by assigned id where the live lock is already gone', () => {
    // The interrupt kills the capped CLI before this build runs, so the failover has no
    // live lock — the assigned id is what keeps "Continue" out of the CLI's picker.
    expect(body).toMatch(/if \(!resumeSessionId && req\.agentId === 'claude'\) resumeSessionId = assignedSessionFor\(/)
  })

  it('never resumes an id claude never WROTE', () => {
    // An assigned id names a conversation before one exists. `claude --resume <unwritten>`
    // prints "no conversation found" and EXITS — killing the pane instead of continuing
    // it. The old chain could not do this: its ids came from files that existed by
    // definition. Found live, 2026-08-03.
    // ONE check, on whichever tier won. Assignment feeds more than one tier, and the
    // restore shelf — the tier that survives a restart — carries fileless ids by design,
    // so guarding only the in-memory tier left the hole open exactly where it mattered.
    expect(body).toMatch(/resumeSessionId && req\.agentId === 'claude' && !claudeTranscriptExists\(resumeSessionId,/)
  })

  it('launches FRESH rather than dropping into the picker when there is nothing to continue', () => {
    // A bare `--resume` is the CLI's session list — a menu of unrelated conversations, in
    // a pane whose own conversation never held a single message.
    expect(body).toMatch(/const resumeFlag = req\.resume && !\(unwritten && !resumeSessionId\)/)
    // The LOCAL build must carry the corrected flag. (The remote arm above still passes
    // req.resume and rightly so — it returns before the resume chain runs at all.)
    expect(body, 'the built command must honour the corrected flag').toMatch(
      /const command = buildLaunchCommand\(\s*req\.agentId,\s*req\.cwd,\s*resumeFlag,/
    )
    expect(body, 'a fresh id may only be minted when nothing is being resumed').toMatch(/!resumeFlag &&\s*!resumeSessionId/)
  })

  it('has no retained-lock tier left to fall through to', () => {
    expect(body, 'the 5-minute retained lock was replaced by the assigned id').not.toMatch(
      /lastPaneSessionLog/
    )
  })
})
