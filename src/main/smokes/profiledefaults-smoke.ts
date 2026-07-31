// MOGGING_PROFILEDEFAULTS — resolution + fan-out (ADR 0022, phase-defaults/02).
//
// The heart of the phase, proven on provider `claude` with THREE isolated homes:
// two pointer profiles (CLAUDE_CONFIG_DIR → tmpA/tmpB) and the PRIMARY user home
// (~/.claude under the fixture root) as a full member. One authored default lands
// in all three settings.json files through the EXISTING enforce writer (foreign
// content preserved); a pin overrides exactly one home; a user-authored scoped
// override is an implicit pin the fan-out never touches; the snapshot labels a
// tier-managed value with its honest source; a secret-shaped default value is
// refused at the boundary. Zero network — the bundled catalog answers offline;
// no real CLI home is ever touched (fixture env is CLEAN — the 2026-07-15 lesson).
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SettingsStore } from '@backend/features/workspace'
import {
  AgentSettingsCatalogService,
  AgentSettingsService,
  codecFor,
  selectAgentConfigSource
} from '@backend/features/agent-settings'
import type { AgentConfigProviderId, AgentConfigTarget, AgentProfile } from '@contracts'

const PROFILE_A = 'profile-work'
const PROFILE_B = 'profile-personal'
const PRIMARY = 'login-claude'

export async function runProfileDefaultsSmoke(): Promise<void> {
  const resultFile = join(process.cwd(), 'out', 'profiledefaults-result.json')
  let result: Record<string, unknown> = { pass: false }
  try {
    const root = join(app.getPath('userData'), 'profiledefaults-fixtures')
    const home = join(root, 'home')
    const homeA = join(root, 'claude-work')
    const homeB = join(root, 'claude-personal')
    for (const dir of [join(home, '.claude'), homeA, homeB]) mkdirSync(dir, { recursive: true })

    const store = new SettingsStore(join(root, 'settings.db'))
    const profiles: AgentProfile[] = [
      { id: PRIMARY, name: 'Default', provider: 'claude', env: {}, order: 0 },
      { id: PROFILE_A, name: 'Work', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homeA }, order: 1 },
      { id: PROFILE_B, name: 'Personal', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homeB }, order: 2 }
    ]
    for (const profile of profiles) store.saveProfile(profile)

    const catalogs = new AgentSettingsCatalogService({
      cacheFile: join(root, 'catalog-cache.json'),
      fetch: async () => { throw new Error('offline fixture') }
    })
    await catalogs.initialize({}, false)

    // Per-target context, mirroring main's resolveContext on fixture paths. env is a
    // CLEAN object: an inherited CLAUDE_CONFIG_DIR (running gates from a Claude pane)
    // must never steer a write into the developer's real home.
    const resolveContext = async (_provider: AgentConfigProviderId, target: AgentConfigTarget) => {
      const profile = target.scope === 'profile'
        ? store.listProfiles().find((candidate) => candidate.id === target.targetId)
        : undefined
      if (target.scope === 'profile') assert(profile, `unknown profile target ${target.targetId}`)
      return {
        paths: {
          home,
          platform: process.platform,
          env: {},
          ...(profile ? { profileEnv: profile.env } : {}),
          profile: target.scope === 'profile',
          execution: target.execution
        },
        scopes: []
      }
    }
    const service = new AgentSettingsService({ catalogs, repository: store, resolveContext })

    const catalog = catalogs.get('claude')
    assert(catalog, 'bundled claude catalog must load offline')
    const mode = catalog.settings.find((candidate) => candidate.path.join('.') === 'permissions.defaultMode')
    assert(mode, 'claude permissions.defaultMode missing from catalog')

    const userTarget: AgentConfigTarget = { scope: 'user', targetId: 'default', execution: { kind: 'local' } }
    const targetOf = (profileId: string): AgentConfigTarget => ({ scope: 'profile', targetId: profileId, execution: { kind: 'local' } })
    const fileOf = async (target: AgentConfigTarget): Promise<string> => {
      const context = await resolveContext('claude', target)
      const source = selectAgentConfigSource('claude', target, 'runtime', context.paths)
      assert(source?.file, `no writable source for ${target.scope}/${target.targetId}`)
      return source.file
    }
    const files = {
      primary: await fileOf(userTarget),
      a: await fileOf(targetOf(PROFILE_A)),
      b: await fileOf(targetOf(PROFILE_B))
    }
    assert.equal(files.primary, join(home, '.claude', 'settings.json'))
    assert.equal(files.a, join(homeA, 'settings.json'))
    assert.equal(files.b, join(homeB, 'settings.json'))

    // Foreign content must ride through the codec write untouched.
    for (const file of Object.values(files)) writeFileSync(file, '{\n  "foreignSetting": true\n}\n')
    const codec = codecFor('json')
    const modeIn = (file: string): unknown => codec.read(readFileSync(file, 'utf8'), mode.path).value
    const foreignIn = (file: string): unknown => codec.read(readFileSync(file, 'utf8'), ['foreignSetting']).value

    // 1) providerHomes: the primary is a FULL member carrying its profile identity.
    const homes = service.providerHomes('claude')
    assert.equal(homes.length, 3)
    assert.deepEqual(homes.find((h) => h.target.scope === 'user')?.profileId, PRIMARY)
    assert.deepEqual(homes.filter((h) => h.target.scope === 'profile').map((h) => h.target.targetId).sort(), [PROFILE_B, PROFILE_A].sort())

    // 2) ONE authored default reaches every home — primary included, foreign bytes kept.
    const setDefault = await service.setAccountDefault('claude', mode.id, 'set', 'plan', 'default')
    assert.equal(setDefault.ok, true, setDefault.reason)
    for (const file of Object.values(files)) {
      assert.equal(modeIn(file), 'plan', `${file} must carry the account default`)
      assert.equal(foreignIn(file), true, `${file} lost its foreign content`)
    }
    const compiled = store.listAgentConfigOverrides({ provider: 'claude' }).filter((row) => row.tier === 'compiled')
    assert.equal(compiled.length, 3, 'fan-out compiles one enforce row per home')
    // 'pending-restart', not 'synced': defaultMode is not a live-activation key —
    // the honest state the one writer reports for every restart-activated setting.
    assert.ok(
      compiled.every((row) => row.ownership === 'enforce' && (row.status === 'synced' || row.status === 'pending-restart')),
      'compiled rows ride the one writer to an applied state'
    )

    // 3) A pin overrides exactly ONE home; the default keeps the other two.
    const setPin = await service.setAccountDefault('claude', mode.id, 'set', 'acceptEdits', 'pin', PROFILE_A)
    assert.equal(setPin.ok, true, setPin.reason)
    assert.equal(modeIn(files.a), 'acceptEdits')
    assert.equal(modeIn(files.b), 'plan')
    assert.equal(modeIn(files.primary), 'plan')

    // 4) The snapshot tells the truth about the source: "Account default" on an
    // unpinned home, the pin on the pinned one.
    const snapshotB = await service.snapshot('claude', targetOf(PROFILE_B))
    assert.equal(snapshotB?.settings.find((state) => state.setting.id === mode.id)?.managedBy, 'account-default')
    const snapshotA = await service.snapshot('claude', targetOf(PROFILE_A))
    assert.equal(snapshotA?.settings.find((state) => state.setting.id === mode.id)?.managedBy, 'pin')
    const snapshotPrimary = await service.snapshot('claude', userTarget)
    assert.equal(snapshotPrimary?.settings.find((state) => state.setting.id === mode.id)?.managedBy, 'account-default')

    // 5) A user-authored scoped override is an IMPLICIT pin — fan-out hands off.
    const manual = await service.set('claude', targetOf(PROFILE_B), mode.id, 'set', 'default', 'enforce')
    assert.equal(manual.ok, true, manual.reason)
    const reapply = await service.applyAccountDefaults('claude')
    assert.equal(reapply.ok, true, reapply.reason)
    assert.equal(modeIn(files.b), 'default', 'a scoped override must beat the account default')
    assert.equal(modeIn(files.a), 'acceptEdits')
    assert.equal(modeIn(files.primary), 'plan')

    // 6) The secret wall holds at the service door too: a secret-shaped VALUE in a
    // free-string setting is refused, and no home moves.
    const freeText = catalog.settings.find((candidate) =>
      candidate.schema.kind === 'string' && !candidate.schema.enum && !candidate.schema.pattern &&
      candidate.writable && !candidate.sensitive && candidate.scopes.includes('user') && candidate.scopes.includes('profile')
    )
    assert(freeText, 'claude catalog offers no free-string setting for the secret bite')
    const refused = await service.setAccountDefault('claude', freeText.id, 'set', 'sk-live-abcdefgh12345678', 'default')
    assert.equal(refused.ok, false, 'a secret-shaped default value must be refused')
    assert.equal(store.listAccountDefaults('claude').filter((row) => row.settingId === freeText.id).length, 0)

    // 7) Values stay out of the result JSON — ids and booleans only.
    store.close()
    result = {
      pass: true,
      homes: 3,
      primaryFullMember: true,
      defaultReachesEveryHome: true,
      foreignContentPreserved: true,
      compiledRowsEnforced: true,
      pinOverridesOneHome: true,
      snapshotLabelsHonest: true,
      implicitPinRespected: true,
      secretDefaultRefused: true
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
