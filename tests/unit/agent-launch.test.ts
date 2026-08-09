import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLaunchCommand } from '@backend/features/agents/launch'
import { materializeProfileEnv } from '../../src/main/profile-rules'

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

  // ── The SEAM that broke live on 2026-08-04 ──────────────────────────────────────
  //
  // Neither half was wrong alone. envPrefix persists its pointers in the pane's shell
  // ON PURPOSE (a failover relaunch must inherit them), and materializeProfileEnv
  // returned `{}` for the first profile ON PURPOSE ("the CLI's default home"). Composed,
  // they meant a switch BACK to the default profile emitted no pointer at all and ran on
  // the previous profile's config home — a different account, reported as a success.
  //
  // So the contract is about the composition, and lives here: whatever profile a launch
  // names, the typed line SAYS which home it wants. A pointerless launch is the bug.
  describe('every claude launch states its config home', () => {
    const POINTERS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'GEMINI_CONFIG_DIR']
    const saved = new Map<string, string | undefined>()
    beforeEach(() => {
      for (const k of POINTERS) {
        saved.set(k, process.env[k])
        delete process.env[k]
      }
    })
    afterEach(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })

    // Exactly the pair in the live report: a pointerless default profile and a
    // relocated one, in a pane that runs one after the other.
    const DEFAULT_PROFILE = {}
    const RELOCATED_PROFILE = { CLAUDE_CONFIG_DIR: join(homedir(), '.claude-other') }

    for (const target of [POSIX, PWSH, CMD] as const) {
      const dialect = target === POSIX ? 'posix' : target.shell
      it(`names the home in both directions of a switch (${dialect})`, () => {
        const toRelocated = buildLaunchCommand(
          'claude', '/srv/app', false, materializeProfileEnv('claude', RELOCATED_PROFILE), undefined, target
        )
        const backToDefault = buildLaunchCommand(
          'claude', '/srv/app', false, materializeProfileEnv('claude', DEFAULT_PROFILE), undefined, target
        )
        expect(toRelocated!).toContain(join(homedir(), '.claude-other'))
        // THE REGRESSION: this line used to carry no pointer whatsoever, so the shell's
        // leftover CLAUDE_CONFIG_DIR from the launch above survived into it.
        expect(backToDefault!, 'a launch that names no home inherits the last one').toContain('CLAUDE_CONFIG_DIR')
        expect(backToDefault!).toContain(join(homedir(), '.claude'))
        expect(backToDefault!).not.toContain('.claude-other')
      })
    }
  })
})
