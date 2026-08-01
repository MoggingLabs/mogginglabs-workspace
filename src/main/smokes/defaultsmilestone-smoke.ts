// MOGGING_DEFAULTSMILESTONE — THE authority on "phase-defaults done" (ADR 0022,
// phase-defaults/05). ONE composed story on provider claude, three isolated homes
// growing to four, zero network, every claim of docs/22 a bite:
//
//   set a default → all three homes carry it, the PRIMARY included
//   pin one account → that home differs, the other two hold the default
//   change the default → unpinned homes follow LIVE, the pin holds
//   a fourth account appears → it adopts the current default on the announce
//   a hand-edit drifts a managed home → the existing reconcile restores it
//   clear the pin → the home re-inherits the shared value
//   remove the default → every key RELEASES (values kept, hand-edits stick)
//   a secret-shaped default → REFUSED at the boundary, nothing persisted
//
// The result JSON is ids + booleans only — no setting value crosses out of here.
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SettingsStore } from '@backend/features/workspace'
import {
  AgentSettingsCatalogService,
  AgentSettingsService,
  codecFor
} from '@backend/features/agent-settings'
import type { AgentConfigProviderId, AgentConfigTarget } from '@contracts'

export async function runDefaultsMilestoneSmoke(): Promise<void> {
  const resultFile = join(process.cwd(), 'out', 'defaultsmilestone-result.json')
  let result: Record<string, unknown> = { pass: false }
  try {
    const root = join(app.getPath('userData'), 'defaultsmilestone-fixtures')
    const home = join(root, 'home')
    const homes = {
      a: join(root, 'claude-work'),
      b: join(root, 'claude-personal'),
      c: join(root, 'claude-fourth')
    }
    for (const dir of [join(home, '.claude'), homes.a, homes.b, homes.c]) mkdirSync(dir, { recursive: true })

    const store = new SettingsStore(join(root, 'settings.db'))
    store.saveProfile({ id: 'ms-primary', name: 'Default', provider: 'claude', env: {}, order: 0 })
    store.saveProfile({ id: 'ms-work', name: 'Work', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homes.a }, order: 1 })
    store.saveProfile({ id: 'ms-personal', name: 'Personal', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homes.b }, order: 2 })

    const catalogs = new AgentSettingsCatalogService({
      cacheFile: join(root, 'catalog-cache.json'),
      fetch: async () => { throw new Error('offline — the milestone runs with zero network') }
    })
    await catalogs.initialize({}, false)

    const resolveContext = async (_provider: AgentConfigProviderId, target: AgentConfigTarget) => {
      const profile = target.scope === 'profile'
        ? store.listProfiles().find((candidate) => candidate.id === target.targetId)
        : undefined
      if (target.scope === 'profile') assert(profile, `unknown profile target ${target.targetId}`)
      return {
        paths: {
          home,
          platform: process.platform,
          env: {}, // clean — an inherited CLAUDE_CONFIG_DIR must never reach a real home
          ...(profile ? { profileEnv: profile.env } : {}),
          profile: target.scope === 'profile',
          execution: target.execution
        },
        scopes: []
      }
    }
    const service = new AgentSettingsService({ catalogs, repository: store, resolveContext })

    const catalog = catalogs.get('claude')
    assert(catalog)
    const mode = catalog.settings.find((candidate) => candidate.path.join('.') === 'permissions.defaultMode')
    assert(mode)
    const codec = codecFor('json')
    const files = {
      primary: join(home, '.claude', 'settings.json'),
      a: join(homes.a, 'settings.json'),
      b: join(homes.b, 'settings.json'),
      c: join(homes.c, 'settings.json')
    }
    for (const file of [files.primary, files.a, files.b]) writeFileSync(file, '{\n  "foreignSetting": true\n}\n')
    const modeIn = (file: string): unknown => codec.read(readFileSync(file, 'utf8'), mode.path).value

    // 1) One default reaches all three homes — the primary included.
    assert.equal((await service.setAccountDefault('claude', mode.id, 'set', 'plan', 'default')).ok, true)
    const defaultEverywhere = modeIn(files.primary) === 'plan' && modeIn(files.a) === 'plan' && modeIn(files.b) === 'plan'
    assert.ok(defaultEverywhere)

    // 2) A pin makes exactly one home differ.
    assert.equal((await service.setAccountDefault('claude', mode.id, 'set', 'acceptEdits', 'pin', 'ms-work')).ok, true)
    const pinDiffers = modeIn(files.a) === 'acceptEdits' && modeIn(files.b) === 'plan' && modeIn(files.primary) === 'plan'
    assert.ok(pinDiffers)

    // 3) Changing the default re-reaches every unpinned home; the pin holds.
    assert.equal((await service.setAccountDefault('claude', mode.id, 'set', 'bypassPermissions', 'default')).ok, true)
    const changeFollows = modeIn(files.primary) === 'bypassPermissions' && modeIn(files.b) === 'bypassPermissions' && modeIn(files.a) === 'acceptEdits'
    assert.ok(changeFollows)

    // 4) A fourth account adopts on the profiles-changed announce (the debounced
    // trigger the profiles feature fires — proven through the same door).
    store.saveProfile({ id: 'ms-fourth', name: 'Fourth', provider: 'claude', env: { CLAUDE_CONFIG_DIR: homes.c }, order: 3 })
    service.scheduleApplyAccountDefaults('claude', 60)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const fourthAdopts = modeIn(files.c) === 'bypassPermissions'
    assert.ok(fourthAdopts, 'the fourth account must inherit the current default')

    // 5) A hand-edit off the default is restored by the EXISTING reconcile.
    writeFileSync(files.b, codec.set(readFileSync(files.b, 'utf8'), mode.path, 'plan'))
    assert.equal((await service.reconcileAll()).ok, true)
    const driftRestored = modeIn(files.b) === 'bypassPermissions'
    assert.ok(driftRestored)

    // 6) Clearing the pin re-inherits the shared value live.
    assert.equal((await service.clearAccountDefault('claude', mode.id, 'pin', 'ms-work')).ok, true)
    const pinCleared = modeIn(files.a) === 'bypassPermissions'
    assert.ok(pinCleared)

    // 7) Removing the default RELEASES every key: values kept, hand-edits stick.
    assert.equal((await service.clearAccountDefault('claude', mode.id, 'default')).ok, true)
    const releasedKept = modeIn(files.primary) === 'bypassPermissions' && modeIn(files.c) === 'bypassPermissions'
    writeFileSync(files.b, codec.set(readFileSync(files.b, 'utf8'), mode.path, 'plan'))
    await service.reconcileAll()
    const handEditSticks = modeIn(files.b) === 'plan'
    assert.ok(releasedKept && handEditSticks)
    assert.equal(store.listAgentConfigOverrides({ provider: 'claude' }).filter((row) => row.tier === 'compiled').length, 0)

    // 8) The secret wall, one last time, at the boundary itself.
    let secretRefused = false
    try {
      store.saveAccountDefault({
        provider: 'claude', scope: 'user', targetId: '__all__', tier: 'default', surface: 'runtime',
        settingId: mode.id, path: [...mode.path], operation: 'set', desiredValue: 'sk-live-abcdefgh12345678',
        ownership: 'enforce', baselinePresent: false, catalogVersion: catalog.catalogVersion,
        status: 'observed', createdAt: 1, updatedAt: 1
      })
    } catch {
      secretRefused = true
    }
    assert.ok(secretRefused)
    assert.equal(store.listAccountDefaults('claude').length, 0)

    // 9) Foreign bytes survived the whole arc; no value or path enters the result.
    const foreignSurvived = [files.primary, files.a, files.b].every((file) => readFileSync(file, 'utf8').includes('"foreignSetting": true'))
    assert.ok(foreignSurvived)
    store.close()

    result = {
      pass: true,
      defaultEverywhere,
      pinDiffers,
      changeFollows,
      fourthAdopts,
      driftRestored,
      pinCleared,
      releasedKept,
      handEditSticks,
      secretRefused,
      foreignSurvived
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
