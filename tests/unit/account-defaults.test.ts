import { describe, expect, it } from 'vitest'
import { managedKeys, resolveDefault } from '@backend/features/agent-settings/account-defaults'
import { AGENT_CONFIG_ALL_ACCOUNTS, type AgentConfigOverrideRecord, type AgentConfigRowTier } from '@contracts'

// THE resolution law (ADR 0022), pinned as a precedence table:
//   value(P, S) = pin(P, S) ?? accountDefault(S) ?? undefined (the home's own file)
// Pure rows in, verdict out — the fan-out and the snapshot labeling both ride this
// one function, so the table lives here and nowhere else.

const row = (overrides: Partial<AgentConfigOverrideRecord> & { tier: AgentConfigRowTier }): AgentConfigOverrideRecord => ({
  provider: 'claude',
  scope: overrides.tier === 'default' ? 'user' : 'profile',
  targetId: overrides.tier === 'default' ? AGENT_CONFIG_ALL_ACCOUNTS : 'profile-a',
  surface: 'runtime',
  settingId: 'setting.s',
  path: ['setting', 's'],
  operation: 'set',
  desiredValue: 'X',
  ownership: 'enforce',
  baselinePresent: false,
  catalogVersion: 'v1',
  status: 'observed',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('resolveDefault — the ADR 0022 precedence table', () => {
  const defaultX = row({ tier: 'default', desiredValue: 'X' })
  const pinAY = row({ tier: 'pin', targetId: 'profile-a', desiredValue: 'Y' })

  it('a pin beats the account default for its own profile only', () => {
    const authored = [defaultX, pinAY]
    expect(resolveDefault(authored, 'profile-a', 'setting.s', 'runtime')).toEqual({ operation: 'set', value: 'Y', source: 'pin' })
    expect(resolveDefault(authored, 'profile-b', 'setting.s', 'runtime')).toEqual({ operation: 'set', value: 'X', source: 'account-default' })
  })

  it('a default answers when no pin matches; nothing answers when neither exists', () => {
    expect(resolveDefault([defaultX], 'profile-a', 'setting.s', 'runtime')).toEqual({ operation: 'set', value: 'X', source: 'account-default' })
    expect(resolveDefault([], 'profile-a', 'setting.s', 'runtime')).toBeUndefined()
    expect(resolveDefault([defaultX], 'profile-a', 'setting.other', 'runtime')).toBeUndefined()
  })

  it('a pin with no default still answers for its home — and ONLY its home', () => {
    expect(resolveDefault([pinAY], 'profile-a', 'setting.s', 'runtime')).toEqual({ operation: 'set', value: 'Y', source: 'pin' })
    expect(resolveDefault([pinAY], 'profile-b', 'setting.s', 'runtime')).toBeUndefined()
  })

  it('an undefined profileId (no profile rows at all) can never match a pin', () => {
    expect(resolveDefault([defaultX, pinAY], undefined, 'setting.s', 'runtime')).toEqual({ operation: 'set', value: 'X', source: 'account-default' })
  })

  it('surfaces are separate namespaces', () => {
    expect(resolveDefault([defaultX], 'profile-a', 'setting.s', 'tui')).toBeUndefined()
  })

  it('unset defaults resolve as unset, carrying no value', () => {
    const unsetDefault = row({ tier: 'default', operation: 'unset', desiredValue: undefined })
    expect(resolveDefault([unsetDefault], 'profile-a', 'setting.s', 'runtime')).toEqual({ operation: 'unset', source: 'account-default' })
  })

  it('compiled rows are engine OUTPUT — never resolution input', () => {
    const compiled = row({ tier: 'compiled', scope: 'profile', targetId: 'profile-a', desiredValue: 'Z' })
    expect(resolveDefault([compiled], 'profile-a', 'setting.s', 'runtime')).toBeUndefined()
  })
})

describe('managedKeys — the fan-out work list', () => {
  it('dedupes across tiers, keeps surfaces distinct, ignores compiled rows', () => {
    const keys = managedKeys([
      row({ tier: 'default' }),
      row({ tier: 'pin', targetId: 'profile-a' }),
      row({ tier: 'default', settingId: 'setting.t', path: ['setting', 't'] }),
      row({ tier: 'default', surface: 'tui' }),
      row({ tier: 'compiled', settingId: 'setting.never' })
    ])
    expect(keys).toEqual([
      { settingId: 'setting.s', surface: 'runtime' },
      { settingId: 'setting.t', surface: 'runtime' },
      { settingId: 'setting.s', surface: 'tui' }
    ])
  })

  it('a pin-only key is still managed — its home enforces, the others fall through', () => {
    expect(managedKeys([row({ tier: 'pin', targetId: 'profile-a' })])).toEqual([{ settingId: 'setting.s', surface: 'runtime' }])
  })
})
