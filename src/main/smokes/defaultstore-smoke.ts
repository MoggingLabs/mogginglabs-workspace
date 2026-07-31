// MOGGING_DEFAULTSTORE — the ADR-0022 default-tier store gate (phase-defaults/01).
//
// Model + persistence only: a provider-level `tier: 'default'` row (sentinel
// `__all__`) and a per-profile `tier: 'pin'` row round-trip through the settings
// store; the legacy override listing stays BLIND to both (the enforce machinery
// must never see a sentinel as a home); a secret-shaped default value is REFUSED
// at the persistence boundary itself; removal is tier-scoped and never touches a
// legacy scoped override; the additive `tier` migration is idempotent across a
// close/reopen. No file in any config home is read or written here — the engine
// that resolves and fans out is step 02's gate (MOGGING_PROFILEDEFAULTS).
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SettingsStore } from '@backend/features/workspace'
import {
  AGENT_CONFIG_ALL_ACCOUNTS,
  type AgentConfigOverrideRecord,
  type AgentConfigValue
} from '@contracts'

/** A minimal, well-formed tier row. The store is dumb about catalogs on purpose —
 *  catalog membership is validated by the engine/UI save paths (steps 02/04). */
function tierRow(overrides: Partial<AgentConfigOverrideRecord>): AgentConfigOverrideRecord {
  return {
    provider: 'claude',
    scope: 'user',
    targetId: AGENT_CONFIG_ALL_ACCOUNTS,
    tier: 'default',
    surface: 'runtime',
    settingId: 'fixture.defaults.marker',
    path: ['fixture', 'defaultsMarker'],
    operation: 'set',
    desiredValue: 'DEFAULT_X_4242',
    ownership: 'enforce',
    baselinePresent: false,
    catalogVersion: 'fixture-1',
    status: 'observed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export async function runDefaultStoreSmoke(): Promise<void> {
  const resultFile = join(process.cwd(), 'out', 'defaultstore-result.json')
  let result: Record<string, unknown> = { pass: false }
  try {
    const root = join(app.getPath('userData'), 'defaultstore-fixtures')
    mkdirSync(root, { recursive: true })
    const dbPath = join(root, 'settings.db')
    const store = new SettingsStore(dbPath)

    // 1) A provider-level default round-trips, tier and sentinel intact.
    store.saveAccountDefault(tierRow({}))
    const defaults = store.listAccountDefaults('claude')
    assert.equal(defaults.length, 1)
    assert.equal(defaults[0].tier, 'default')
    assert.equal(defaults[0].targetId, AGENT_CONFIG_ALL_ACCOUNTS)
    assert.equal(defaults[0].desiredValue, 'DEFAULT_X_4242')

    // 2) The blindness law: the legacy listing NEVER returns tier rows — with or
    // without filters, so reconcileAll/launch reconcile cannot enforce a sentinel.
    assert.equal(store.listAgentConfigOverrides().length, 0)
    assert.equal(store.listAgentConfigOverrides({ provider: 'claude' }).length, 0)
    assert.equal(store.listAgentConfigOverrides({ provider: 'claude', scope: 'user' }).length, 0)

    // 3) A pin rides the same store, keyed by its profile — and both tiers list.
    store.saveAccountDefault(tierRow({ tier: 'pin', scope: 'profile', targetId: 'profile-work', desiredValue: 'PIN_Y_4242' }))
    assert.equal(store.listAccountDefaults('claude').length, 2)
    assert.equal(store.listAccountDefaults('claude', 'pin')[0]?.targetId, 'profile-work')
    assert.equal(store.listAgentConfigOverrides().length, 0)

    // 3b) The collision that ate the first pin: a COMPILED enforce row for the
    // same home shares the pin's logical key — the `__pin__:` storage namespace
    // must keep BOTH alive (the authored pin listed, the compiled row enforced),
    // and a profile-targeted purge must reap the pin alongside the home's rows.
    store.saveAgentConfigOverride(tierRow({ tier: 'compiled', scope: 'profile', targetId: 'profile-work', desiredValue: 'COMPILED_Y_4242', status: 'synced' }))
    assert.equal(store.listAccountDefaults('claude', 'pin').length, 1, 'the compiled row must not swallow the authored pin')
    assert.equal(store.listAgentConfigOverrides({ provider: 'claude' }).filter((row) => row.tier === 'compiled').length, 1)
    store.removeAgentConfigTarget('profile', 'profile-work')
    assert.equal(store.listAccountDefaults('claude', 'pin').length, 0, 'a deleted profile must not leave an orphan pin')
    assert.equal(store.listAgentConfigOverrides({ provider: 'claude' }).length, 0)
    store.saveAccountDefault(tierRow({ tier: 'pin', scope: 'profile', targetId: 'profile-work', desiredValue: 'PIN_Y_4242' }))

    // 4) Secret-shaped values are REFUSED at the boundary — string shapes (the
    // review redactor) and secret-shaped map keys (the agent-settings detector).
    const refused = (value: AgentConfigValue): void => {
      assert.throws(() => store.saveAccountDefault(tierRow({ settingId: 'fixture.defaults.secret', path: ['fixture', 'secret'], desiredValue: value })))
    }
    refused('sk-live-abcdefgh12345678')
    refused('ghp_ABCDEFGHIJKLMNOPQRST12')
    refused({ apiKey: 'plain-looking-value' })
    refused({ nested: { list: ['ok', 'sk-live-abcdefgh12345678'] } })
    assert.equal(store.listAccountDefaults('claude').length, 2, 'a refused save must persist nothing')

    // 5) Malformed tier shapes are refused: a default with a real targetId, a pin
    // without one, and a tier-less row through the guarded door.
    assert.throws(() => store.saveAccountDefault(tierRow({ targetId: 'profile-work' })))
    assert.throws(() => store.saveAccountDefault(tierRow({ tier: 'pin', scope: 'profile', targetId: AGENT_CONFIG_ALL_ACCOUNTS })))
    assert.throws(() => store.saveAccountDefault(tierRow({ tier: undefined })))

    // 6) Removal is tier-scoped. A legacy scoped override on the SAME setting id
    // survives both tier removals untouched.
    const legacy = tierRow({ tier: undefined, scope: 'user', targetId: 'default', status: 'synced' })
    store.saveAgentConfigOverride(legacy)
    assert.equal(store.listAgentConfigOverrides().length, 1)
    store.removeAccountDefault('claude', 'fixture.defaults.marker')
    assert.equal(store.listAccountDefaults('claude', 'default').length, 0)
    store.removeAccountDefault('claude', 'fixture.defaults.marker', { tier: 'pin', targetId: 'profile-work' })
    assert.equal(store.listAccountDefaults('claude').length, 0)
    assert.equal(store.listAgentConfigOverrides().length, 1, 'tier removal must never touch a legacy override')

    // 7) Upsert keeps identity: re-saving a default preserves createdAt, adopts the
    // new value, and stays a single row.
    store.saveAccountDefault(tierRow({ createdAt: 7, updatedAt: 7 }))
    store.saveAccountDefault(tierRow({ createdAt: 99, updatedAt: 8, desiredValue: 'DEFAULT_Z_4242' }))
    const updated = store.listAccountDefaults('claude', 'default')
    assert.equal(updated.length, 1)
    assert.equal(updated[0].createdAt, 7, 'ON CONFLICT must not rewrite createdAt')
    assert.equal(updated[0].desiredValue, 'DEFAULT_Z_4242')

    // 8) The additive migration is idempotent and rows survive a reopen — the
    // "old db meets new column" path every shipped profile db will take.
    store.close()
    const reopened = new SettingsStore(dbPath)
    assert.equal(reopened.listAccountDefaults('claude').length, 1)
    assert.equal(reopened.listAgentConfigOverrides().length, 1)

    // 9) JSON-safety: the serialized records carry no secret bytes and no
    // filesystem path — ids and values only (and values are non-secret by 4).
    const serialized = JSON.stringify([...reopened.listAccountDefaults('claude'), ...reopened.listAgentConfigOverrides()])
    assert.ok(!serialized.includes('sk-live'), 'no refused secret may survive anywhere in the store')
    assert.ok(!serialized.includes(root.replaceAll('\\', '\\\\')), 'no filesystem path in a serialized record')
    reopened.close()

    result = {
      pass: true,
      roundTrip: true,
      legacyBlind: true,
      pinKeyed: true,
      secretRefused: true,
      shapeRefused: true,
      removalTierScoped: true,
      createdAtStable: true,
      migrationIdempotent: true,
      jsonSafe: true
    }
  } catch (error) {
    result = { pass: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
  }
  try {
    mkdirSync(join(process.cwd(), 'out'), { recursive: true })
    writeFileSync(resultFile, JSON.stringify(result, null, 2))
  } catch {
    // Best effort; a missing result is a loud gate failure.
  }
  app.exit(result.pass ? 0 : 1)
}
