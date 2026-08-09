import { describe, expect, it } from 'vitest'
import { buildLaunchCommand } from '@backend/features/agents/launch'
import { parseLegacyLaunchCommand } from '@backend/features/workspace/legacy-launch-parse'

// This parser is the inverse of buildLaunchCommand, and it is the only place a legacy command
// line is ever read. The golden tests below compose with the real builder and parse the result,
// so the two cannot drift: adding a shell dialect to the builder fails these until the parser
// learns it.

const CWD_WIN = 'C:\\Users\\pveloso01\\Documents\\projects\\mogginglabs-workspace'
const HOME_CMAIN = 'C:\\Users\\pveloso01\\.claude-cmain'

describe('parseLegacyLaunchCommand — golden inverse of buildLaunchCommand', () => {
  const targets = [
    { name: 'cmd', spec: { platform: 'windows', shell: 'cmd' } as const, cwd: CWD_WIN },
    { name: 'powershell', spec: { platform: 'windows', shell: 'powershell' } as const, cwd: CWD_WIN },
    { name: 'posix', spec: { platform: 'posix', shell: 'sh' } as const, cwd: '/home/p/projects/ws' }
  ]

  for (const t of targets) {
    it(`recovers agent, cwd and profile pointer from a ${t.name} launch line`, () => {
      const built = buildLaunchCommand('claude', t.cwd, false, { CLAUDE_CONFIG_DIR: HOME_CMAIN }, undefined, t.spec)
      expect(built).toBeTruthy()
      const intent = parseLegacyLaunchCommand(built)
      expect(intent).toMatchObject({
        agentId: 'claude',
        cwd: t.cwd,
        configDir: HOME_CMAIN,
        source: 'legacy'
      })
    })

    it(`recovers a profile-less ${t.name} launch line`, () => {
      const built = buildLaunchCommand('codex', t.cwd, false, undefined, undefined, t.spec)
      const intent = parseLegacyLaunchCommand(built)
      expect(intent).toMatchObject({ agentId: 'codex', cwd: t.cwd, source: 'legacy' })
      expect(intent?.configDir).toBeUndefined()
    })

    it(`recovers the exact session id from a ${t.name} resume line`, () => {
      const id = '0c519a63-c370-4392-bf6d-1a2b3c4d5e6f'
      const built = buildLaunchCommand('claude', t.cwd, true, undefined, undefined, t.spec, id)
      expect(parseLegacyLaunchCommand(built)?.sessionId).toBe(id)
    })

    it(`survives a cwd containing a quote on ${t.name}`, () => {
      const odd = t.spec.platform === 'posix' ? "/home/p/it's" : CWD_WIN
      const built = buildLaunchCommand('claude', odd, false, undefined, undefined, t.spec)
      expect(parseLegacyLaunchCommand(built)?.cwd).toBe(odd)
    })
  }
})

// Verbatim rows measured in the live daemon store that shipped the bug. If these ever stop
// parsing, the recovery path for real users' panes has silently regressed.
describe('parseLegacyLaunchCommand — real persisted rows', () => {
  const SETTINGS =
    'C:\\Users\\pveloso01\\AppData\\Roaming\\mogginglabs-workspace\\context-relay\\claude-launch-0c519a63c370392f.settings.json'

  it('recovers the profile from a row that carried CLAUDE_CONFIG_DIR', () => {
    const row = `cd /d "${CWD_WIN}" && set "CLAUDE_CONFIG_DIR=${HOME_CMAIN}" && claude --settings ${SETTINGS}`
    expect(parseLegacyLaunchCommand(row)).toMatchObject({
      agentId: 'claude',
      cwd: CWD_WIN,
      configDir: HOME_CMAIN,
      source: 'legacy'
    })
  })

  it('recovers the agent from a row that carried no profile pointer', () => {
    const row = `cd /d "C:\\Users\\pveloso01\\Documents" && claude --settings ${SETTINGS}`
    const intent = parseLegacyLaunchCommand(row)
    expect(intent).toMatchObject({ agentId: 'claude', cwd: 'C:\\Users\\pveloso01\\Documents' })
    expect(intent?.configDir).toBeUndefined()
  })

  // THE REGRESSION PIN. The shipped resume matcher took command.split(/\s+/)[0] — which is
  // `cd` for every command the app has ever built — so it resumed 0 of 34 real panes. Any
  // future first-token shortcut fails here.
  it('does not mistake the cd prefix for the agent', () => {
    const row = `cd /d "${CWD_WIN}" && set "CLAUDE_CONFIG_DIR=${HOME_CMAIN}" && claude`
    expect(row.trim().split(/\s+/)[0]).toBe('cd')
    expect(parseLegacyLaunchCommand(row)?.agentId).toBe('claude')
  })

  it('uses the row cwd when the command carries no cd prefix', () => {
    expect(parseLegacyLaunchCommand('claude', { cwd: CWD_WIN })).toMatchObject({
      agentId: 'claude',
      cwd: CWD_WIN
    })
  })

  it('prefers the command cwd over the row cwd when both exist', () => {
    const row = `cd /d "${CWD_WIN}" && claude`
    expect(parseLegacyLaunchCommand(row, { cwd: 'C:\\somewhere\\else' })?.cwd).toBe(CWD_WIN)
  })
})

describe('parseLegacyLaunchCommand — refusals', () => {
  it.each([null, undefined, '', 42 as unknown as string])('returns null for %p', (raw) => {
    expect(parseLegacyLaunchCommand(raw)).toBeNull()
  })

  it('returns null for a plain shell pane', () => {
    expect(parseLegacyLaunchCommand('npm run dev', { cwd: CWD_WIN })).toBeNull()
    expect(parseLegacyLaunchCommand(`cd /d "${CWD_WIN}" && npm run dev`)).toBeNull()
  })

  it('returns null for a CLI the registry does not know', () => {
    expect(parseLegacyLaunchCommand(`cd /d "${CWD_WIN}" && cursor-agent`)).toBeNull()
  })

  it('never throws on malformed input', () => {
    for (const raw of ['cd /d "unterminated && claude', "cd 'x", 'Set-Location ', 'set "K=V" && ', '\u0000']) {
      expect(() => parseLegacyLaunchCommand(raw)).not.toThrow()
    }
  })

  it('refuses a cwd that could not be typed safely', () => {
    expect(parseLegacyLaunchCommand('claude', { cwd: 'C:\\x\r\nwhoami' })).toBeNull()
  })
})
