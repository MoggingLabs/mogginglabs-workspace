import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeLogin } from '@backend/features/agents/logins'
import type { AgentProfile } from '@contracts'

// The login probe behind the profiles list's `login` decoration and the launch
// sign-in hint. Each case is a home SHAPE the probes document: claude's state
// file + credentials marker, codex's JWT-carried email, gemini's oauth marker +
// accounts file under the <base>/.gemini quirk. The negative space matters as
// much: an empty home is a CHECKED "signed out", an unknown provider is
// undefined (unknowable), and a malformed state file never throws.

const profile = (provider: string, env: Record<string, string>): AgentProfile => ({
  id: `t-${provider}`,
  name: 'Test',
  provider,
  env,
  order: 0
})

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')

describe('probeLogin', () => {
  let root: string
  const saved: Record<string, string | undefined> = {}

  beforeAll(() => {
    // Ambient pointers would silently re-aim resolveHome's DEFAULT-home compare;
    // the suite must see the same world on every machine.
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'GEMINI_CONFIG_DIR']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    root = mkdtempSync(join(tmpdir(), 'mogging-logins-'))
  })

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
    rmSync(root, { recursive: true, force: true })
  })

  const home = (name: string): string => {
    const h = join(root, name)
    mkdirSync(h, { recursive: true })
    return h
  }

  it('returns undefined for a provider with no probe (unknowable, not signed-out)', () => {
    expect(probeLogin('aider', profile('aider', {}))).toBeUndefined()
  })

  it('claude: an empty home is a CHECKED signed-out', () => {
    const h = home('claude-empty')
    expect(probeLogin('claude', profile('claude', { CLAUDE_CONFIG_DIR: h }))).toEqual({ signedIn: false })
  })

  it('claude: a credentials file marks the login even without an email label', () => {
    const h = home('claude-creds')
    writeFileSync(join(h, '.credentials.json'), '{}')
    expect(probeLogin('claude', profile('claude', { CLAUDE_CONFIG_DIR: h }))).toEqual({ signedIn: true, email: undefined })
  })

  it('claude: the state file names the account', () => {
    const h = home('claude-state')
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@mogging.test' } }))
    expect(probeLogin('claude', profile('claude', { CLAUDE_CONFIG_DIR: h }))).toEqual({ signedIn: true, email: 'dev@mogging.test' })
  })

  it('claude: a malformed state file reads as signed-out, never a throw', () => {
    const h = home('claude-broken')
    writeFileSync(join(h, '.claude.json'), '{not json')
    expect(probeLogin('claude', profile('claude', { CLAUDE_CONFIG_DIR: h }))).toEqual({ signedIn: false })
  })

  it("codex: the id_token's claims carry the email; only the email survives", () => {
    const h = home('codex-jwt')
    const idToken = `${b64url({ alg: 'none' })}.${b64url({ email: 'codex@mogging.test' })}.sig`
    writeFileSync(join(h, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken } }))
    expect(probeLogin('codex', profile('codex', { CODEX_HOME: h }))).toEqual({ signedIn: true, email: 'codex@mogging.test' })
  })

  it('codex: unreadable claims still count as a login, just unlabeled', () => {
    const h = home('codex-opaque')
    writeFileSync(join(h, 'auth.json'), JSON.stringify({ tokens: { id_token: 'not.a.jwt' } }))
    expect(probeLogin('codex', profile('codex', { CODEX_HOME: h }))).toEqual({ signedIn: true, email: undefined })
  })

  it('gemini: probes <base>/.gemini (the pointer quirk), marker + accounts file', () => {
    const base = home('gem-match')
    const g = join(base, '.gemini')
    mkdirSync(g, { recursive: true })
    writeFileSync(join(g, 'oauth_creds.json'), '{}')
    writeFileSync(join(g, 'google_accounts.json'), JSON.stringify({ active: 'gem@mogging.test' }))
    expect(probeLogin('gemini', profile('gemini', { GEMINI_CLI_HOME: base }))).toEqual({ signedIn: true, email: 'gem@mogging.test' })
    // Fixtures at the BASE (not <base>/.gemini) must NOT read as a login.
    const wrong = home('gem-wrongdepth')
    writeFileSync(join(wrong, 'oauth_creds.json'), '{}')
    expect(probeLogin('gemini', profile('gemini', { GEMINI_CLI_HOME: wrong }))).toEqual({ signedIn: false })
  })

  it('gemini: an empty home is a CHECKED signed-out', () => {
    const base = home('gem-empty')
    expect(probeLogin('gemini', profile('gemini', { GEMINI_CLI_HOME: base }))).toEqual({ signedIn: false })
  })
})
