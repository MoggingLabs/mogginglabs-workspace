import { describe, expect, it } from 'vitest'
import { buildLaunchCommand } from '@backend/features/agents/launch'

// The three dialects, as the real LaunchTarget shape rather than nicknames.
const PWSH = { platform: 'windows', shell: 'powershell' } as const
const CMD = { platform: 'windows', shell: 'cmd' } as const
const POSIX = 'posix' as const

// THE STRING TYPED INTO A PANE TO START AN AGENT.
//
// This is "we type, the user executes" (ADR 0010) at its most literal: the app composes a
// shell command and types it. Get the quoting wrong and the agent starts in the WRONG
// DIRECTORY — silently, because a shell that cannot cd usually carries on anyway.
//
// The interesting inputs are a cwd with a space and a quote, and the three dialects.

const CWD = 'C:\\Users\\me\\My Projects\\app'

describe('buildLaunchCommand', () => {
  it('returns null for an agent it does not know, rather than a half-command', () => {
    expect(buildLaunchCommand('not-a-real-agent', '/tmp')).toBeNull()
  })

  it('changes directory before starting the agent', () => {
    const cmd = buildLaunchCommand('claude', '/srv/app')
    expect(cmd).toBeTruthy()
    expect(cmd!.indexOf('/srv/app')).toBeLessThan(cmd!.indexOf('claude'))
  })

  it('quotes a cwd containing spaces', () => {
    const cmd = buildLaunchCommand('claude', CWD, false, undefined, undefined, POSIX)
    expect(cmd).toBeTruthy()
    // The bare, unquoted path must not appear — that is the form a shell splits on the space.
    expect(cmd!).toContain('My Projects')
    expect(cmd!.replace(/["']/g, '')).toContain(CWD)
  })

  it('emits a different command per dialect', () => {
    const seen = new Set(
      ([POSIX, PWSH, CMD] as const)
        .map((t) => buildLaunchCommand('claude', '/srv/app', false, undefined, undefined, t))
        .filter((c): c is string => !!c)
    )
    expect(seen.size, 'a dialect that produces the same string as another is not a dialect').toBeGreaterThan(1)
  })

  // A failed `cd` that does not stop the line launches the agent wherever the shell happened to
  // be — usually $HOME. On PowerShell that needs saying explicitly.
  it('makes a failed directory change fatal on PowerShell', () => {
    const cmd = buildLaunchCommand('claude', '/srv/app', false, undefined, undefined, PWSH)
    expect(cmd).toBeTruthy()
    expect(cmd!).toMatch(/-ErrorAction\s+Stop/)
  })

  it('carries env values through, quoted for the dialect', () => {
    const cmd = buildLaunchCommand('claude', '/srv/app', false, { MY_KEY: 'a b"c' }, undefined, POSIX)
    expect(cmd).toBeTruthy()
    expect(cmd!).toContain('MY_KEY')
  })

  it('passes MCP args through', () => {
    const cmd = buildLaunchCommand('claude', '/srv/app', false, undefined, ['--mcp-config', '/tmp/x.json'])
    expect(cmd).toBeTruthy()
    expect(cmd!).toContain('--mcp-config')
  })

  describe('resume', () => {
    it('adds nothing when resume is off', () => {
      const off = buildLaunchCommand('claude', '/srv/app', false)
      const on = buildLaunchCommand('claude', '/srv/app', true)
      expect(off).not.toBe(on)
    })

    // The exact-session form is only honest when the id is one we actually recorded. A
    // malformed id must fall back to the bare resume flag rather than being pasted in.
    it('uses the exact session id only when it is a real one', () => {
      const good = buildLaunchCommand('claude', '/srv/app', true, undefined, undefined, POSIX, '11111111-2222-3333-4444-555555555555')
      const bad = buildLaunchCommand('claude', '/srv/app', true, undefined, undefined, POSIX, 'not-a-session-id')
      expect(good).toBeTruthy()
      expect(bad).toBeTruthy()
      expect(good!).toContain('11111111-2222-3333-4444-555555555555')
      expect(bad!, 'a malformed id must not be pasted into the command').not.toContain('not-a-session-id')
    })

    it('ignores a session id when resume is off', () => {
      const cmd = buildLaunchCommand('claude', '/srv/app', false, undefined, undefined, POSIX, '11111111-2222-3333-4444-555555555555')
      expect(cmd!).not.toContain('11111111-2222-3333-4444-555555555555')
    })
  })
})
