import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from './temp-dir'
import { deriveProfileDefaults, materializeProfileEnv, sanitizeProfile } from '../../src/main/profile-rules'
import { resolveHome } from '../../src/backend/features/usage/homes'
import type { AgentProfile } from '@contracts'

/** A minimal profile shell for the resolveHome round-trips below — only `env` matters. */
const PROFILE: AgentProfile = { id: 'p-x', name: 'X', provider: 'claude', env: {}, order: 0 }

// The profile save boundary, exercised headless (audit F7 — this logic was
// smoke-only). sanitizeProfile IS the ADR-0002 line: a secret-shaped env value
// must be unsaveable, scanned as the KEY=VALUE pair (the key is half the
// scrub's power). deriveProfileDefaults owns the home-derivation identity
// rules; materializeProfileEnv the legacy-tilde normalization.

const base = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'p-1',
  name: 'Work',
  provider: 'claude',
  env: {},
  order: 0,
  ...over
})

const profile = (id: string, order: number, env: Record<string, string> = {}, provider = 'claude'): AgentProfile => ({
  id,
  name: id,
  provider,
  env,
  order
})

describe('sanitizeProfile', () => {
  it('accepts a plain pointer profile and trims the name', () => {
    const p = sanitizeProfile(base({ name: '  Work  ', env: { CLAUDE_CONFIG_DIR: '~/claude-work' } }))
    expect(p).not.toBeNull()
    expect(p!.name).toBe('Work')
    expect(p!.env).toEqual({ CLAUDE_CONFIG_DIR: '~/claude-work' })
  })

  it('refuses a key-named credential even when the value alone matches no token shape', () => {
    // 40 ordinary chars — no token prefix, no entropy signature. Only the
    // KEY=VALUE pair scan catches it; scanning the value alone let exactly
    // these credentials into plaintext SQLite.
    expect(sanitizeProfile(base({ env: { ANTHROPIC_API_KEY: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' } }))).toBeNull()
  })

  it('refuses a token-shaped value under an innocent key', () => {
    expect(sanitizeProfile(base({ env: { CLAUDE_CONFIG_DIR: 'ghp_abcdefghij0123456789' } }))).toBeNull()
  })

  it('refuses shell-hostile values (quote, backtick, CR/LF, dollar)', () => {
    for (const v of ['a"b', 'a`b', 'a\rb', 'a\nb', '$HOME/x']) {
      expect(sanitizeProfile(base({ env: { CLAUDE_CONFIG_DIR: v } }))).toBeNull()
    }
  })

  it('refuses malformed env names and oversized entry sets', () => {
    expect(sanitizeProfile(base({ env: { lower_case: 'x' } }))).toBeNull()
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`VAR_${i}A`, 'x']))
    expect(sanitizeProfile(base({ env: eleven }))).toBeNull()
  })

  it('refuses bad ids, orders and emails; blank email becomes undefined', () => {
    expect(sanitizeProfile(base({ id: 'has space' }))).toBeNull()
    expect(sanitizeProfile(base({ order: -1 }))).toBeNull()
    expect(sanitizeProfile(base({ order: 100 }))).toBeNull()
    expect(sanitizeProfile(base({ order: 1.5 }))).toBeNull()
    expect(sanitizeProfile(base({ email: 'not-an-email' }))).toBeNull()
    expect(sanitizeProfile(base({ email: '  ' }))!.email).toBeUndefined()
    expect(sanitizeProfile(base({ email: 'a@b.co' }))!.email).toBe('a@b.co')
  })
})

describe('deriveProfileDefaults', () => {
  it('first profile per provider keeps the default home (empty env)', () => {
    const out = deriveProfileDefaults({ id: 'p-1', name: 'Work', provider: 'claude' }, []) as Record<string, unknown>
    expect(out.env).toEqual({})
    expect(out.order).toBe(0)
  })

  it('second profile derives its own pointer home and appends the order', () => {
    const existing = [profile('p-1', 0)]
    const out = deriveProfileDefaults({ id: 'p-2', name: 'Personal!', provider: 'claude' }, existing) as {
      env: Record<string, string>
      order: number
    }
    expect(out.order).toBe(1)
    expect(out.env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude-personal'))
  })

  it('a taken derived home gets a collision suffix', () => {
    const taken = join(homedir(), '.claude-personal')
    const existing = [profile('p-1', 0), profile('p-2', 1, { CLAUDE_CONFIG_DIR: taken })]
    const out = deriveProfileDefaults({ id: 'p-3', name: 'Personal', provider: 'claude' }, existing) as {
      env: Record<string, string>
    }
    expect(out.env.CLAUDE_CONFIG_DIR).toBe(`${taken}-2`)
  })

  it('an EDIT keeps the stored env and order (a home is an identity)', () => {
    const stored = profile('p-2', 1, { CLAUDE_CONFIG_DIR: join(homedir(), '.claude-old') })
    const out = deriveProfileDefaults({ id: 'p-2', name: 'Renamed', provider: 'claude' }, [stored]) as {
      env: Record<string, string>
      order: number
    }
    expect(out.env).toEqual(stored.env)
    expect(out.order).toBe(1)
  })

  it('explicit env/order in the payload are honored as-is', () => {
    const out = deriveProfileDefaults(
      { id: 'p-9', name: 'X', provider: 'claude', env: { CLAUDE_CONFIG_DIR: '~/x' }, order: 7 },
      [profile('p-1', 0)]
    ) as { env: Record<string, string>; order: number }
    expect(out.env).toEqual({ CLAUDE_CONFIG_DIR: '~/x' })
    expect(out.order).toBe(7)
  })
})

describe('materializeProfileEnv', () => {
  const scratch = makeTempDir('profile-rules-')
  afterAll(() => removeTempDir(scratch))

  // The AMBIENT pointers decide what "no pointer of its own" resolves to, and this
  // suite runs under whatever shell invoked vitest — which, in this repo, is routinely
  // a Claude Code session carrying CLAUDE_CONFIG_DIR. Neutralize them per-test (the
  // same reason logins.test.ts does) and give the ambient branch its own case.
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

  it('passes env through untouched for providers without a pointer', () => {
    expect(materializeProfileEnv('opencode', { SOME_VAR: '~/x' })).toEqual({ SOME_VAR: '~/x' })
  })

  it('normalizes a bare tilde to the OS home', () => {
    expect(materializeProfileEnv('claude', { CLAUDE_CONFIG_DIR: '~' }).CLAUDE_CONFIG_DIR).toBe(homedir())
  })

  it('keeps an absolute pointer and creates the directory', () => {
    const home = join(scratch, 'claude-work')
    expect(existsSync(home)).toBe(false)
    const out = materializeProfileEnv('claude', { CLAUDE_CONFIG_DIR: home })
    expect(out.CLAUDE_CONFIG_DIR).toBe(home)
    expect(existsSync(home)).toBe(true)
  })

  // THE REGRESSION (found live 2026-08-04). A profile with no pointer is the FIRST
  // profile — "the CLI's default home" — and it used to emit an empty env. Because the
  // launch line's pointers persist in the pane's shell, that empty env inherited the
  // previous profile's home: switching back to this profile changed the app's label and
  // nothing else, and /status kept reporting the other account's email. The default
  // home must be STATED, so it can overwrite what the last launch left set.
  it('pins the default home for a profile that carries no pointer', () => {
    expect(materializeProfileEnv('claude', {}).CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude'))
    expect(materializeProfileEnv('codex', {}).CODEX_HOME).toBe(join(homedir(), '.codex'))
    // A launch with no profile at all lands in the same pane and inherits the same
    // stale pointer — it is pinned for the same reason.
    expect(materializeProfileEnv('claude', undefined).CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude'))
  })

  it('pins gemini to the pointer PARENT, matching resolveHome', () => {
    // GEMINI_CLI_HOME names the home's parent; resolveHome joins '.gemini' onto it.
    expect(materializeProfileEnv('gemini', {}).GEMINI_CLI_HOME).toBe(homedir())
    expect(resolveHome('gemini', { ...PROFILE, provider: 'gemini', env: materializeProfileEnv('gemini', {}) })).toBe(
      join(homedir(), '.gemini')
    )
  })

  it('honors an ambient pointer, so the launch home and the read home agree', () => {
    const relocated = join(scratch, 'ambient-home')
    process.env.CLAUDE_CONFIG_DIR = relocated
    const env = materializeProfileEnv('claude', {})
    expect(env.CLAUDE_CONFIG_DIR).toBe(relocated)
    expect(resolveHome('claude', { ...PROFILE, env })).toBe(relocated)
  })

  it('never overrides a pointer the profile names itself', () => {
    process.env.CLAUDE_CONFIG_DIR = join(scratch, 'ambient-home')
    const own = join(scratch, 'claude-owned')
    expect(materializeProfileEnv('claude', { CLAUDE_CONFIG_DIR: own }).CLAUDE_CONFIG_DIR).toBe(own)
  })
})
