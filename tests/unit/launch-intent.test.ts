import { describe, expect, it } from 'vitest'
import {
  LAUNCH_INTENT_VERSION,
  launchIntentPrecedence,
  normalizeLaunchIntent,
  type PaneLaunchIntent
} from '@contracts'

// Launch intent is the composer's INPUT, persisted so a restore can re-compose instead of
// re-parsing an opaque command line. The normalizer is the boundary the fail-closed restore
// guard is built on: a row that names an agent but whose intent will not normalize must
// degrade visibly, never fall through to a plain shell.

const valid: PaneLaunchIntent = {
  v: LAUNCH_INTENT_VERSION,
  agentId: 'claude',
  cwd: 'C:\\Users\\p\\project',
  profileId: 'cmain',
  configDir: 'C:\\Users\\p\\.claude-cmain',
  sessionId: '0c519a63-c370-4392-bf6d-1a2b3c4d5e6f',
  source: 'declared',
  at: 1_700_000_000_000
}

describe('normalizeLaunchIntent', () => {
  it('round-trips a full intent through JSON, the way the store carries it', () => {
    expect(normalizeLaunchIntent(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it('accepts the minimum: agent, cwd, source, at', () => {
    const min = { v: LAUNCH_INTENT_VERSION, agentId: 'codex', cwd: '/home/p/x', source: 'detected', at: 1 }
    expect(normalizeLaunchIntent(min)).toEqual(min)
  })

  it.each([null, undefined, 42, 'claude', [], [valid]])('refuses a non-object (%p)', (raw) => {
    expect(normalizeLaunchIntent(raw)).toBeNull()
  })

  // A newer build's intent is refused rather than guessed at — a downgrade shows a pane that
  // SAYS it could not be read. Guessing is how the original bug shipped.
  it('refuses an unknown version', () => {
    expect(normalizeLaunchIntent({ ...valid, v: LAUNCH_INTENT_VERSION + 1 })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, v: 0 })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, v: '1' })).toBeNull()
  })

  it('refuses an agent id outside the canonical vocabulary', () => {
    expect(normalizeLaunchIntent({ ...valid, agentId: 'cd' })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, agentId: 'claude-code' })).toBeNull()
  })

  it('refuses a missing or unusable cwd', () => {
    expect(normalizeLaunchIntent({ ...valid, cwd: '' })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, cwd: 42 })).toBeNull()
    // These paths are TYPED into an interactive shell downstream.
    expect(normalizeLaunchIntent({ ...valid, cwd: 'C:\\x\r\nwhoami' })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, cwd: 'C:\\' + 'a'.repeat(5000) })).toBeNull()
  })

  it('refuses a bad source and a bad timestamp', () => {
    expect(normalizeLaunchIntent({ ...valid, source: 'guessed' })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, at: -1 })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, at: Number.NaN })).toBeNull()
  })

  it('refuses a malformed profile id, config dir, or session id rather than dropping it', () => {
    expect(normalizeLaunchIntent({ ...valid, profileId: 'has space' })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, configDir: 'C:\\x\u0000y' })).toBeNull()
    expect(normalizeLaunchIntent({ ...valid, sessionId: 'not-a-uuid' })).toBeNull()
  })

  it('normalizes a session id to lower case, the form the command line carries', () => {
    const upper = { ...valid, sessionId: valid.sessionId!.toUpperCase() }
    expect(normalizeLaunchIntent(upper)?.sessionId).toBe(valid.sessionId)
  })

  it('drops unknown keys instead of carrying them into the store', () => {
    const out = normalizeLaunchIntent({ ...valid, settingsPath: 'C:\\generated.json', bell: ['x'] })
    expect(out).toEqual(valid)
  })
})

describe('launchIntentPrecedence', () => {
  const declared: PaneLaunchIntent = { ...valid }
  const now = 1_800_000_000_000

  // The single most important rule in the file: detection going null means the agent EXITED,
  // not that the pane stopped being an agent pane. Clearing intent here would re-create the
  // original bug for every agent that ever exits cleanly.
  it('keeps intent when detection goes null', () => {
    expect(launchIntentPrecedence(declared, null, now)).toBe(declared)
  })

  it('keeps a declared intent over a detection of the same agent', () => {
    const out = launchIntentPrecedence(declared, { agentId: 'claude', cwd: 'C:\\elsewhere' }, now)
    expect(out).toBe(declared)
    expect(out?.configDir).toBe(valid.configDir)
  })

  it('adopts a detection when the pane has no intent — the hand-typed agent', () => {
    const out = launchIntentPrecedence(undefined, { agentId: 'claude', cwd: 'C:\\p' }, now)
    expect(out).toEqual({
      v: LAUNCH_INTENT_VERSION,
      agentId: 'claude',
      cwd: 'C:\\p',
      source: 'detected',
      at: now
    })
  })

  it('replaces when a DIFFERENT agent is detected — quit claude, typed codex', () => {
    const out = launchIntentPrecedence(declared, { agentId: 'codex', cwd: 'C:\\p' }, now)
    expect(out?.agentId).toBe('codex')
    expect(out?.source).toBe('detected')
    // The old profile pointer must not ride along onto a different provider.
    expect(out?.configDir).toBeUndefined()
    expect(out?.profileId).toBeUndefined()
  })

  it('does not churn the intent when the same agent is detected repeatedly', () => {
    const first = launchIntentPrecedence(undefined, { agentId: 'claude', cwd: 'C:\\p' }, now)
    const second = launchIntentPrecedence(first, { agentId: 'claude', cwd: 'C:\\p' }, now + 5000)
    expect(second).toBe(first)
  })

  it('ignores a detection it cannot trust', () => {
    expect(launchIntentPrecedence(declared, { agentId: 'bash', cwd: 'C:\\p' }, now)).toBe(declared)
    expect(launchIntentPrecedence(declared, { agentId: 'codex', cwd: '' }, now)).toBe(declared)
  })
})
