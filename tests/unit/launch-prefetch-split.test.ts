import { describe, expect, it } from 'vitest'
import { bodyWithoutComments, sourceOf } from './source-body'

// A BUILD THAT MIGHT BE DISCARDED MUST SPEND NOTHING.
//
// Resume launches could not prefetch their command build, because building consumed
// one-shot config overrides and the restore shelf's exact-session intent, and CLEARED
// the pane's session declaration — while a resume may still adopt a daemon-reattached
// agent and type nothing at all. `consume: false` splits those effects off so the build
// can run during the pane-live/spawn-settled waits; `commandCommit` claims them at the
// moment the command is really typed.
//
// The dangerous half is the one with no visible symptom: a prefetch that clears a live
// pane's declaration, or a commit that never happens while the one-shots are already
// spent. main/agents.ts and the agents feature import electron, so the shape is pinned
// here; LAUNCHNOW (no double-consume), RESUME (adopt discards a prefetch) and PROFSWITCH
// prove the behavior.

/** launchInPane's own body. Its signature spans lines and its `opts?: {` object type
 *  would capture a `{\n` anchor, so slice to the declaration first and then brace-match
 *  from the return type. */
function launchInPaneBody(): string {
  const src = sourceOf('src/ui/features/agents/index.ts')
  const at = src.indexOf('async function launchInPane(')
  expect(at, 'launchInPane was renamed — re-anchor this file rather than deleting it').toBeGreaterThan(-1)
  return bodyWithoutComments(src.slice(at), '): Promise<void> {')
}

describe('main defers a prefetch build effects', () => {
  const body = bodyWithoutComments(
    sourceOf('src/main/agents.ts'),
    'ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest)'
  )

  it('only PEEKS the restore shelf when the build may be discarded', () => {
    expect(body).toMatch(/consumeNow\s*\?\s*consumeRestoreResumeSessionId\(/)
    expect(body).toMatch(/:\s*peekRestoreResumeSessionId\(/)
  })

  it('does not touch the pane identity on a prefetch', () => {
    // expectPaneSession(paneId, agentId, null) CLEARS the declaration and drops the pane's
    // assigned session id — catastrophic for a pane whose living agent is about to be
    // adopted. Both writes must sit INSIDE the consumeNow arm, never before it.
    const guarded = /if \(consumeNow\) \{[^}]*expectPaneSession\([^}]*rememberAssignedSession\(/s
    expect(body, 'the identity writes must be gated on the build being real').toMatch(guarded)
    expect(body.replace(guarded, ''), 'no ungated identity write may remain').not.toMatch(
      /expectPaneSession\(req\.paneId/
    )
  })

  it('defers the one-shots and the agent-bearing mark behind the same flag', () => {
    expect(body).toMatch(/if \(consumeNow\) \{/)
    expect(body).toMatch(/markAgentConfigSessionLaunched\(req\)/)
    expect(body).toMatch(/pendingLaunches\.set\(req\.paneId/)
  })
})

describe('commit applies exactly what the prefetch deferred', () => {
  const body = bodyWithoutComments(
    sourceOf('src/main/agents.ts'),
    'ipcMain.handle(AgentChannels.commandCommit, (_e, req: AgentCommandCommitRequest)'
  )

  it('claims a pending record once, and only for the same provider', () => {
    expect(body, 'a second commit must find nothing').toMatch(/pendingLaunches\.delete\(paneId\)/)
    expect(body).toMatch(/pending\.agentId !== req\?\.agentId/)
  })

  it('refuses an aged-out record rather than typing on stale intent', () => {
    expect(body).toMatch(/PENDING_LAUNCH_TTL_MS/)
  })

  it('applies the shelf consume, the declaration, the mark and the one-shots', () => {
    expect(body).toMatch(/consumeRestoreResumeSessionId\(paneId, pending\.agentId\)/)
    expect(body).toMatch(/expectPaneSession\(paneId, pending\.agentId, pending\.expectedFile\)/)
    expect(body).toMatch(/notePaneAgent\(paneId, true\)/)
    expect(body).toMatch(/markAgentConfigSessionLaunched\(/)
  })
})

describe('the renderer commits before it types', () => {
  const body = launchInPaneBody()

  it('claims the deferred effects ahead of the write', () => {
    const commitAt = body.indexOf('commandCommit(')
    // The CLI write specifically — a `custom:` provider writes its own command earlier
    // in this function and has no deferred effects to claim.
    // Prefix, not the whole call: the write also carries the build's launch INTENT, and a
    // gate about ORDER must not fail because an argument was added.
    const typeAt = body.indexOf('agentsClient.launchInto(paneId, result.command')
    expect(commitAt, 'the declaration must be in place before the CLI writes its first log line').toBeGreaterThan(-1)
    expect(typeAt, 'the CLI write must still be here to order against').toBeGreaterThan(-1)
    expect(commitAt).toBeLessThan(typeAt)
  })

  it('rebuilds consumingly when nothing was pending', () => {
    expect(body).toMatch(/if \(!committed\.ok\)/)
  })

  it('prefetches resume launches deferred, fresh launches as before', () => {
    expect(body).toMatch(/resume \? \{ consume: false \} : undefined/)
  })
})

describe('the switch keeps its interrupt clear of the build', () => {
  // Measured: a build running alongside the interrupt starved main — the process-table
  // verdict took 9.6s instead of ~1s, because main relays that verdict AND was busy in
  // the build's synchronous filesystem work. The build is ~free now anyway.
  const body = bodyWithoutComments(sourceOf('src/ui/features/agents/index.ts'), 'async function switchPaneProfile(')

  it('does not start a build before the interrupt', () => {
    const buildAt = body.indexOf('prepareCliLaunch(')
    const interruptAt = body.indexOf('await interruptAgent(paneId)')
    expect(interruptAt).toBeGreaterThan(-1)
    expect(buildAt === -1 || buildAt > interruptAt, 'the interrupt must have main to itself').toBe(true)
  })
})
