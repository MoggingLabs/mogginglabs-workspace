import { describe, expect, it } from 'vitest'
import { bodyWithoutComments, sourceOf } from './source-body'

// ONE LAUNCH IS ONE INSTANT — it should read each fact once.
//
// A single agent launch used to query the profile table three times (the launch's own
// profile, the pooling siblings, and again inside the settings reconcile), probe the
// same config home's login files twice for two questions about one answer, and — worst
// — resolve a full store fan-out (workspaces + profiles + remotes) once per reconciled
// SETTING ROW, for a `scopes` list only the settings panel ever reads.
//
// These modules import electron (`app`, `ipcMain`) or are a large stateful service
// whose fakes would outweigh the fix — the same reason reconcile-events.test.ts pins
// its own invariant over source. So the SHAPE is asserted here, with anchors that
// throw when they stop matching; behavior stays the gates' job (PROFILES, LOGINTRUTH,
// SETAGENTCFG, LAUNCHNOW).

describe('the launch command handler reads each fact once', () => {
  const body = bodyWithoutComments(
    sourceOf('src/main/agents.ts'),
    'ipcMain.handle(AgentChannels.command, async (_e, req: AgentCommandRequest)'
  )

  it('probes the login exactly once', () => {
    const probes = body.match(/probeLogin\(/g) ?? []
    expect(
      probes.length,
      'signIn and needsSignIn ask different questions of the SAME probe result'
    ).toBe(1)
    expect(body, 'the one probe must resolve the launch home').toContain('probeLogin(req.agentId, profile ?? null)')
  })

  it('lists profiles exactly once and reuses the rows', () => {
    const lists = body.match(/listProfiles\(\)/g) ?? []
    expect(lists.length, 'the profile lookup and the pooling sources share one read').toBe(1)
    expect(body, 'the resolved profile is handed to the settings reconcile').toContain(
      'prepareAgentConfigLaunch(req, profile)'
    )
  })

  it('still refuses a launch whose named profile is gone', () => {
    // The memo must not soften the refusal: a named-but-missing profile is a refusal,
    // not a silent default-profile launch.
    expect(body).toMatch(/req\.profileId && !profile/)
  })
})

describe('reconcileRows resolves each target once per batch', () => {
  const body = bodyWithoutComments(
    sourceOf('src/backend/features/agent-settings/service.ts'),
    'private async reconcileRows('
  )

  it('goes through the batch memo, not straight to the resolver', () => {
    expect(body, 'the per-row resolver call is the fan-out that made launches slow').not.toMatch(
      /await this\.options\.resolveContext\(/
    )
    expect(body).toContain('await resolveContextOnce(row.provider, target)')
  })

  it('keys the memo by the whole target identity', () => {
    // A memo keyed on less than this would serve one target's paths for another's row.
    expect(body).toMatch(/target\.scope/)
    expect(body).toMatch(/target\.targetId/)
    expect(body).toMatch(/target\.execution\.kind/)
    expect(body).toMatch(/hostId/)
  })
})

describe('resolveContext defers the scope walk', () => {
  const src = sourceOf('src/main/agent-settings.ts')

  it('exposes scopes as a memoized getter, not an eager call', () => {
    const body = bodyWithoutComments(src, 'async function resolveContext(')
    expect(body, 'the launch path reads only paths — scopeOptions is panel work').toMatch(
      /get scopes\(\)/
    )
    expect(body).toMatch(/scopesMemo \?\?= scopeOptions\(provider, target\)/)
  })

  it('reads the remote list once per scope walk, not per workspace host', () => {
    const body = bodyWithoutComments(src, 'function scopeOptions(')
    expect(body).toMatch(/const remotes = store\?\.listRemotes\(\) \?\? \[\]/)
    expect(body, 'the per-host lookup must use the hoisted list').not.toMatch(
      /store\?\.listRemotes\(\)\.find\(/
    )
  })
})
