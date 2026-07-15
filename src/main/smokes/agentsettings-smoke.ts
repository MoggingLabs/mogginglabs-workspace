import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { SettingsStore } from '@backend/features/workspace'
import {
  AgentSettingsCatalogService,
  AgentSettingsService,
  agentConfigValueContainsSecretKey,
  codecFor,
  resolveAgentConfigSources,
  runCodecFixtureAssertions,
  selectAgentConfigSource,
  validateAgentConfigMutation,
  type AgentConfigPathContext,
  type CodexConfigResolverPort
} from '@backend/features/agent-settings'
import { compileJsonSchemaCatalog, validateCatalog } from '@backend/features/agent-settings/catalog/compiler.mjs'
import { AGENT_CLI_REGISTRY, validateAgentCliRegistryCoverage } from '@backend/core/agent-clis'
import { configMutationCoordinator } from '@backend/core/config-files'
import type {
  AgentConfigProviderId,
  AgentConfigScopeOption,
  AgentConfigSetting,
  AgentConfigTarget,
  AgentConfigValue
} from '@contracts'

const choices: Record<AgentConfigProviderId, { path: string; value: AgentConfigValue }> = {
  claude: { path: 'permissions.defaultMode', value: 'bypassPermissions' },
  codex: { path: 'model', value: 'gpt-5-smoke' },
  gemini: { path: 'advanced.autoConfigureMemory', value: false },
  aider: { path: 'verify-ssl', value: false },
  opencode: { path: 'model', value: 'openai/gpt-5-smoke' }
}

function setting(catalogs: AgentSettingsCatalogService, provider: AgentConfigProviderId): AgentConfigSetting {
  const choice = choices[provider]
  const found = catalogs.get(provider)?.settings.find((candidate) => candidate.path.join('.') === choice.path)
  assert(found, `${provider}/${choice.path} missing from catalog`)
  return found
}

export async function runAgentSettingsSmoke(): Promise<void> {
  const resultFile = join(process.cwd(), 'out', 'agentsettings-result.json')
  let result: Record<string, unknown> = { pass: false }
  try {
    runCodecFixtureAssertions()
    validateAgentCliRegistryCoverage()
    for (const key of ['apiKey', 'apiKeys', 'accessToken', 'refreshToken', 'authToken', 'bearerToken', 'clientSecret', 'privateKey', 'clientKey', 'secretKey', 'password', 'passphrase', 'credentials', 'customHeaders']) {
      assert.equal(agentConfigValueContainsSecretKey({ [key]: 'fixture' }), true, `${key} must be treated as secret-shaped`)
    }
    for (const key of ['token_budget', 'tokenLimit', 'model_auto_compact_token_limit', 'tool_output_token_limit', 'cli_auth_credentials_store', 'secret_auth_storage', 'apiKeyHelper', 'API_KEY_HELPER_TTL_MS', 'headerTimeout']) {
      assert.equal(agentConfigValueContainsSecretKey({ [key]: 'fixture' }), false, `${key} must not be treated as a secret value`)
    }

    const unionCatalog = compileJsonSchemaCatalog({
      provider: 'opencode',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flexible: {
            default: 'auto',
            oneOf: [
              { type: 'string', enum: ['auto', 'manual'] },
              {
                type: 'object',
                required: ['level'],
                additionalProperties: false,
                properties: { level: { type: 'integer', minimum: 1 } }
              }
            ]
          },
          primitive: { type: ['string', 'boolean'], default: true },
          overlap: { oneOf: [{ type: 'number' }, { type: 'integer' }] }
        }
      },
      sourceUrl: 'https://opencode.ai/config.json',
      checkedAt: 1
    })
    validateCatalog(unionCatalog)
    const flexible = unionCatalog.settings.find((candidate) => candidate.path.join('.') === 'flexible')!
    const primitive = unionCatalog.settings.find((candidate) => candidate.path.join('.') === 'primitive')!
    const overlap = unionCatalog.settings.find((candidate) => candidate.path.join('.') === 'overlap')!
    assert.equal(flexible.schema.kind, 'union')
    assert.equal(flexible.schema.unionMode, 'oneOf')
    assert.equal(flexible.schema.alternatives?.length, 2)
    assert.equal(validateAgentConfigMutation(flexible, 'auto', 'set').ok, true)
    assert.equal(validateAgentConfigMutation(flexible, { level: 2 }, 'set').ok, true)
    assert.equal(validateAgentConfigMutation(flexible, 'unsupported', 'set').ok, false)
    assert.equal(validateAgentConfigMutation(flexible, {}, 'set').ok, false)
    assert.equal(validateAgentConfigMutation(flexible, { level: 2, extra: true }, 'set').ok, false)
    assert.equal(validateAgentConfigMutation(primitive, false, 'set').ok, true)
    assert.equal(validateAgentConfigMutation(primitive, 'value', 'set').ok, true)
    assert.equal(validateAgentConfigMutation(primitive, 2, 'set').ok, false)
    assert.equal(validateAgentConfigMutation(overlap, 1, 'set').ok, false, 'oneOf must reject an ambiguous value')
    assert.equal(validateAgentConfigMutation(overlap, 1.5, 'set').ok, true)

    const badDefault = compileJsonSchemaCatalog({
      provider: 'opencode',
      schema: { type: 'object', properties: { invalid: { anyOf: [{ type: 'string' }, { type: 'boolean' }], default: 7 } } },
      sourceUrl: 'https://opencode.ai/config.json',
      checkedAt: 1
    })
    badDefault.settings[0].defaultValue = 7
    assert.throws(() => validateCatalog(badDefault), /default value/i)

    const root = join(app.getPath('userData'), 'agentsettings-fixtures')
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    const appData = join(home, 'AppData', 'Roaming')
    mkdirSync(cwd, { recursive: true })

    // Runtime refresh must consume both declared Aider sources. A compact
    // synthetic upstream pair keeps the gate offline while exercising the
    // same HTML/sample compiler and last-known-good commit path.
    const aiderOptions = [
      ['timeout', 'Timeout in seconds for API calls', 'xxx', ''],
      ['max-chat-history-tokens', 'Soft limit on tokens for chat history', 'xxx', ''],
      ['cache-keepalive-pings', 'Number of cache keepalive pings', 'false', 'Default: 0'],
      ['map-tokens', 'Suggested number of tokens to use for repo map', 'xxx', ''],
      ['map-multiplier-no-files', 'Multiplier for map tokens when no files are specified', 'true', 'Default: 2'],
      ['set-env', 'Set an environment variable (can be used multiple times)', 'xxx', 'Default: []'],
      ['api-key', 'Set an API key for a provider', 'xxx', 'Default: []'],
      ['alias', 'Add a model alias (can be used multiple times)', 'xxx', ''],
      ['lint-cmd', 'Specify lint commands (can be used multiple times)', 'xxx', 'Default: []'],
      ['file', 'Specify a file to edit (can be used multiple times)', 'xxx', ''],
      ['read', 'Specify a read-only file (can be used multiple times)', 'xxx', ''],
      ['config', 'Specify the config file', 'xxx', ''],
      ...Array.from({ length: 120 }, (_, index) => [`fixture-${index}`, `Fixture option ${index}`, 'xxx', ''])
    ] as Array<[string, string, string, string]>
    const aiderSampleFixture = [
      '# Sample .aider.conf.yml',
      '# This file lists all valid configuration entries.',
      '# options:',
      ...aiderOptions.flatMap(([key, description, value]) => [`## ${description}`, `#${key}: ${value}`])
    ].join('\n')
    const aiderHelpFixture = [
      '<p>usage: aider [options]</p>',
      ...aiderOptions.map(([key, description, _value, defaultLine]) =>
        `<h3><code>--${key} VALUE</code></h3><p>${description}<br>${defaultLine}${defaultLine ? '<br>' : ''}Environment variable: <code>AIDER_${key.replace(/-/g, '_').toUpperCase()}</code></p>`)
    ].join('\n')
    const aiderRefreshRequests: string[] = []
    const aiderRefreshCatalogs = new AgentSettingsCatalogService({
      cacheFile: join(root, 'aider-refresh-cache.json'),
      fetch: async (input) => {
        const url = String(input)
        aiderRefreshRequests.push(url)
        const text = url === 'https://aider.chat/docs/config/options.html'
          ? aiderHelpFixture
          : url.endsWith('/sample.aider.conf.yml')
            ? aiderSampleFixture
            : undefined
        if (!text) throw new Error(`Unexpected Aider fixture URL: ${url}`)
        const response = new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } })
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
    })
    await aiderRefreshCatalogs.initialize({}, false)
    const refreshedAider = await aiderRefreshCatalogs.refresh('aider', 'fixture-version')
    assert.equal(refreshedAider?.stale, false)
    assert(aiderRefreshRequests.includes('https://aider.chat/docs/config/options.html'), 'Aider option reference was skipped during runtime refresh')
    assert(aiderRefreshRequests.some((url) => url.endsWith('/sample.aider.conf.yml')), 'Aider all-options sample was skipped during runtime refresh')
    const refreshedRows = new Map(refreshedAider!.settings.map((row) => [row.path[0], row]))
    assert.equal(refreshedRows.get('map-tokens')?.schema.kind, 'integer')
    assert.equal(refreshedRows.get('map-multiplier-no-files')?.schema.kind, 'number')
    assert.equal(refreshedRows.get('read')?.schema.kind, 'array')
    assert.equal(refreshedRows.get('set-env')?.sensitive, true)
    assert.equal(refreshedRows.get('set-env')?.writable, false)
    assert.equal(refreshedRows.get('config')?.writable, false)
    assert.deepEqual(refreshedRows.get('config')?.scopes, ['session'])

    const pathContext: AgentConfigPathContext = {
      home,
      cwd,
      platform: process.platform,
      env: { ...process.env, APPDATA: appData, XDG_CONFIG_HOME: join(home, '.config') },
      execution: { kind: 'local' }
    }

    // Registry scopes must resolve to real provider layers; remote targets must
    // never fall through to a local lookalike path.
    for (const definition of AGENT_CLI_REGISTRY) {
      const ordinary = resolveAgentConfigSources(definition.id, pathContext)
      const profiled = resolveAgentConfigSources(definition.id, { ...pathContext, profile: true, profileEnv: {} })
      const represented = new Set([...ordinary, ...profiled].map((source) => source.scope))
      for (const scope of definition.config.scopes) assert(represented.has(scope), `${definition.id}/${scope} has no source`)
      const remote = resolveAgentConfigSources(definition.id, { ...pathContext, execution: { kind: 'ssh', hostId: 'fixture' } })
      assert(remote.every((source) => source.file === undefined && !source.writable), `${definition.id} remote source leaked a local file`)
    }
    const openCodeSources = resolveAgentConfigSources('opencode', pathContext)
    const openCodeGlobalFiles = openCodeSources
      .filter((source) => source.scope === 'user' && source.surface === 'runtime')
      .map((source) => source.file)
    for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
      assert(openCodeGlobalFiles.includes(join(home, '.config', 'opencode', name)), `OpenCode global ${name} is not represented independently`)
    }
    const inlineOpenCode = resolveAgentConfigSources('opencode', {
      ...pathContext,
      env: { ...pathContext.env, OPENCODE_CONFIG_CONTENT: '{"model":"fixture/model"}' }
    })
    assert(inlineOpenCode.some((source) => source.inlineText?.includes('fixture/model') && !source.writable), 'OpenCode inline content is not represented read-only')
    const openCodeRepo = join(root, 'opencode-repo')
    const openCodeIntermediate = join(openCodeRepo, 'packages')
    const openCodeNested = join(openCodeIntermediate, 'app')
    const openCodeConfigDir = join(home, 'opencode-custom-dir')
    for (const directory of [join(openCodeRepo, '.git'), join(root, '.opencode'), join(openCodeRepo, '.opencode'), join(openCodeIntermediate, '.opencode'), join(openCodeNested, '.opencode'), join(home, '.opencode'), openCodeConfigDir]) {
      mkdirSync(directory, { recursive: true })
    }
    const layeredOpenCode = resolveAgentConfigSources('opencode', {
      ...pathContext,
      cwd: openCodeNested,
      env: { ...pathContext.env, OPENCODE_CONFIG_DIR: openCodeConfigDir }
    })
    const openCodeRuntimeOrder = layeredOpenCode
      .filter((source) => source.surface === 'runtime' && source.file)
      .map((source) => source.file as string)
    const expectedOpenCodeOrder = [
      join(openCodeRepo, 'opencode.json'),
      join(openCodeRepo, 'opencode.jsonc'),
      join(openCodeIntermediate, 'opencode.json'),
      join(openCodeIntermediate, 'opencode.jsonc'),
      join(openCodeNested, 'opencode.json'),
      join(openCodeNested, 'opencode.jsonc'),
      join(openCodeNested, '.opencode', 'opencode.json'),
      join(openCodeNested, '.opencode', 'opencode.jsonc'),
      join(openCodeIntermediate, '.opencode', 'opencode.json'),
      join(openCodeIntermediate, '.opencode', 'opencode.jsonc'),
      join(openCodeRepo, '.opencode', 'opencode.json'),
      join(openCodeRepo, '.opencode', 'opencode.jsonc'),
      join(home, '.opencode', 'opencode.json'),
      join(home, '.opencode', 'opencode.jsonc'),
      join(openCodeConfigDir, 'opencode.json'),
      join(openCodeConfigDir, 'opencode.jsonc')
    ]
    let previousOpenCodeIndex = -1
    for (const file of expectedOpenCodeOrder) {
      const index = openCodeRuntimeOrder.indexOf(file)
      assert(index > previousOpenCodeIndex, `OpenCode source precedence is wrong at ${file}`)
      previousOpenCodeIndex = index
    }
    assert(!openCodeRuntimeOrder.includes(join(root, '.opencode', 'opencode.json')), 'OpenCode runtime config-directory discovery crossed its Git worktree boundary')
    const openCodeTuiOrder = layeredOpenCode
      .filter((source) => source.surface === 'tui' && source.file)
      .map((source) => source.file as string)
    const expectedOpenCodeTuiOrder = [
      join(root, 'tui.json'),
      join(root, 'tui.jsonc'),
      join(openCodeRepo, 'tui.json'),
      join(openCodeRepo, 'tui.jsonc'),
      join(openCodeIntermediate, 'tui.json'),
      join(openCodeIntermediate, 'tui.jsonc'),
      join(openCodeNested, 'tui.json'),
      join(openCodeNested, 'tui.jsonc'),
      join(openCodeNested, '.opencode', 'tui.json'),
      join(openCodeNested, '.opencode', 'tui.jsonc'),
      join(openCodeIntermediate, '.opencode', 'tui.json'),
      join(openCodeIntermediate, '.opencode', 'tui.jsonc'),
      join(openCodeRepo, '.opencode', 'tui.json'),
      join(openCodeRepo, '.opencode', 'tui.jsonc'),
      join(root, '.opencode', 'tui.json'),
      join(root, '.opencode', 'tui.jsonc'),
      join(home, '.opencode', 'tui.json'),
      join(home, '.opencode', 'tui.jsonc'),
      join(openCodeConfigDir, 'tui.json'),
      join(openCodeConfigDir, 'tui.jsonc')
    ]
    let previousOpenCodeTuiIndex = -1
    for (const file of expectedOpenCodeTuiOrder) {
      const index = openCodeTuiOrder.indexOf(file)
      assert(index > previousOpenCodeTuiIndex, `OpenCode TUI source precedence is wrong at ${file}`)
      previousOpenCodeTuiIndex = index
    }
    assert(layeredOpenCode.some((source) => source.file === join(home, '.opencode', 'opencode.jsonc') && source.scope === 'user'), 'OpenCode legacy home config directory must remain a user layer')
    assert(layeredOpenCode.some((source) => source.file === join(openCodeConfigDir, 'opencode.jsonc') && source.scope === 'user'), 'OpenCode custom config directory must remain a user layer')
    const geminiProfileRoot = join(home, 'gemini-profile-root')
    const geminiProfileSources = resolveAgentConfigSources('gemini', {
      ...pathContext,
      profile: true,
      profileEnv: { GEMINI_CLI_HOME: geminiProfileRoot },
      env: { ...pathContext.env, GEMINI_CONFIG_DIR: join(home, 'legacy-process-gemini') }
    })
    assert(geminiProfileSources.some((source) => source.scope === 'profile' && source.file === join(geminiProfileRoot, '.gemini', 'settings.json')), 'Gemini saved current pointer must beat process legacy pointer')
    const aiderRepo = join(root, 'aider-repo')
    const aiderNested = join(aiderRepo, 'packages', 'app')
    mkdirSync(join(aiderRepo, '.git'), { recursive: true })
    mkdirSync(aiderNested, { recursive: true })
    const aiderLayers = resolveAgentConfigSources('aider', { ...pathContext, cwd: aiderNested })
      .filter((source) => source.scope === 'project')
      .map((source) => source.file)
    assert(aiderLayers.includes(join(aiderRepo, '.aider.conf.yml')) && aiderLayers.includes(join(aiderNested, '.aider.conf.yml')), 'Aider git-root/current-directory layers are incomplete')
    assert.deepEqual(aiderLayers, [join(aiderRepo, '.aider.conf.yml'), join(aiderNested, '.aider.conf.yml')], 'Aider must not load .aider.conf.yml from intermediate directories')

    let catalogFetches = 0
    const catalogs = new AgentSettingsCatalogService({
      cacheFile: join(root, 'catalog-cache.json'),
      fetch: async () => { catalogFetches += 1; throw new Error('offline fixture') }
    })
    await catalogs.initialize({}, false)
    const counts = Object.fromEntries(AGENT_CLI_REGISTRY.map(({ id }) => [id, catalogs.get(id)?.settings.length ?? 0]))
    assert(counts.claude >= 200 && counts.codex >= 100 && counts.gemini >= 100 && counts.aider >= 100 && counts.opencode >= 100)

    const store = new SettingsStore(join(root, 'settings.db'))
    const resolveContext = async (_provider: AgentConfigProviderId, target: AgentConfigTarget) => ({
      paths: { ...pathContext, execution: target.execution, profile: target.scope === 'profile' },
      scopes: [{ target, label: target.scope, description: 'fixture', writable: target.execution.kind === 'local' }] as AgentConfigScopeOption[]
    })
    let codexResolverCalls = 0
    const codexResolver: CodexConfigResolverPort = {
      async observe(request) {
        codexResolverCalls += 1
        assert.equal(request.cwd, cwd)
        const model = request.settings.find((candidate) => candidate.path.join('.') === 'model')
        assert(model)
        return {
          settings: {
            [model.id]: {
              effective: {
                present: true,
                known: true,
                value: 'gpt-5-managed-fixture',
                sourceLabel: 'Managed device policy',
                sourceScope: 'system-policy'
              },
              constrained: true
            }
          }
        }
      }
    }
    const service = new AgentSettingsService({ catalogs, repository: store, resolveContext, codexResolver })
    const target: AgentConfigTarget = { scope: 'user', targetId: 'default', execution: { kind: 'local' } }
    const markers: Record<AgentConfigProviderId, string> = {
      claude: '"foreignSetting": true',
      codex: '# foreign-toml',
      gemini: '// foreign-gemini',
      aider: '# foreign-yaml',
      opencode: '// foreign-opencode'
    }

    // Seed a foreign key/comment, then drive every provider through the same
    // catalog -> desired state -> native codec pipeline.
    for (const { id } of AGENT_CLI_REGISTRY) {
      const selected = setting(catalogs, id)
      const source = selectAgentConfigSource(id, target, selected.surface, pathContext)
      assert(source?.file)
      mkdirSync(join(source.file, '..'), { recursive: true })
      const initial = source.format === 'toml'
        ? `${markers[id]}\nforeign_setting = "keep"\n`
        : source.format === 'yaml'
          ? `${markers[id]}\nforeign-setting: keep\n`
          : source.format === 'json'
            ? `{\n  ${markers[id]}\n}\n`
            : `{\n  ${markers[id]}\n  "foreignSetting": true,\n}\n`
      writeFileSync(source.file, initial, 'utf8')
      const changed = await service.set(id, target, selected.id, 'set', choices[id].value, 'enforce')
      assert.equal(changed.ok, true, `${id}: ${changed.reason}`)
      const after = readFileSync(source.file, 'utf8')
      assert(after.includes(markers[id]), `${id} lost foreign formatting`)
      assert.deepEqual(codecFor(source.format).read(after, selected.path).value, choices[id].value)
    }

    // Codex app-server remains the authority for effective values and layer
    // origins, while the selected file value still comes from the lossless
    // TOML codec. The service port is injected so this fixture is offline and
    // deterministic.
    const codexAuthoritative = await service.snapshot('codex', target)
    const codexModelState = codexAuthoritative!.settings.find((state) => state.setting.path.join('.') === 'model')!
    assert.equal(codexModelState.selected.value, choices.codex.value)
    assert.equal(codexModelState.effective.value, 'gpt-5-managed-fixture')
    assert.equal(codexModelState.effective.sourceLabel, 'Managed device policy')
    assert.equal(codexModelState.effective.sourceScope, 'system-policy')
    assert.equal(codexModelState.constrained, true)
    assert.equal(codexResolverCalls, 1)
    assert(!JSON.stringify(codexAuthoritative).includes(root), 'authoritative Codex observation leaked a provider path')

    const codexFallback = new AgentSettingsService({ catalogs, repository: store, resolveContext })
    const unknownCodex = await codexFallback.snapshot('codex', target)
    const unknownModel = unknownCodex!.settings.find((state) => state.setting.path.join('.') === 'model')!
    assert.equal(unknownModel.selected.value, choices.codex.value)
    assert.equal(unknownModel.effective.known, false)
    assert.match(unknownCodex!.message ?? '', /app-server/i)

    // Claude's motivating bypass mode is durable, drift-healed, and reversible.
    const claudeSetting = setting(catalogs, 'claude')
    const claudeSource = selectAgentConfigSource('claude', target, 'runtime', pathContext)!
    const claudeCodec = codecFor(claudeSource.format)
    const drifted = claudeCodec.set(readFileSync(claudeSource.file!, 'utf8'), claudeSetting.path, 'default')
    writeFileSync(claudeSource.file!, drifted, 'utf8')
    assert.equal((await service.reconcileAll()).ok, true)
    assert.equal(claudeCodec.read(readFileSync(claudeSource.file!, 'utf8'), claudeSetting.path).value, 'bypassPermissions')

    const snapshot = await service.snapshot('claude', target)
    assert(snapshot)
    assert(!JSON.stringify(snapshot).includes(root), 'backend path crossed the snapshot boundary')

    // Sensitive values may be observed only as presence; their literal never
    // enters IPC-shaped state or desired-state persistence.
    const sensitive = catalogs.get('claude')!.settings.find((candidate) => candidate.sensitive && candidate.schema.kind === 'string')!
    assert(sensitive)
    const literal = 'sk-agentcfg-smoke-literal-never-crosses-ipc'
    writeFileSync(claudeSource.file!, claudeCodec.set(readFileSync(claudeSource.file!, 'utf8'), sensitive.path, literal), 'utf8')
    const redacted = await service.snapshot('claude', target)
    const sensitiveState = redacted!.settings.find((state) => state.setting.id === sensitive.id)!
    assert.equal(sensitiveState.selected.redacted, true)
    assert(!JSON.stringify(redacted).includes(literal))
    const refusedSecret = await service.set('claude', target, sensitive.id, 'set', literal, 'enforce')
    assert.equal(refusedSecret.ok, false)

    const remoteRefused = await service.set(
      'claude',
      { ...target, execution: { kind: 'ssh', hostId: 'fixture' } },
      claudeSetting.id,
      'set',
      'default',
      'enforce'
    )
    assert.equal(remoteRefused.ok, false)

    // Every provider's session dialect is compiled without touching a provider file.
    const sessionShapes: Record<string, boolean> = {}
    for (const { id } of AGENT_CLI_REGISTRY) {
      const selected = setting(catalogs, id)
      const sessionTarget: AgentConfigTarget = { scope: 'session', targetId: 'workspace-fixture', execution: { kind: 'local' } }
      const staged = await service.set(id, sessionTarget, selected.id, 'set', choices[id].value, 'once')
      assert.equal(staged.ok, true, `${id} session: ${staged.reason}`)
      const overlay = service.prepareSession(id, 'workspace-fixture')
      assert.equal(overlay.issues.length, 0)
      sessionShapes[id] = id === 'codex' || id === 'aider' ? overlay.args.length > 0 : Object.keys(overlay.runtime).length > 0
      assert.equal(sessionShapes[id], true)
      service.markSessionLaunched(id, 'workspace-fixture')
      assert.equal(service.sessionRows(id, 'workspace-fixture').length, 0)
    }

    // Compare-and-swap catches an out-of-band writer before replacement.
    const casFile = join(root, 'cas.json')
    writeFileSync(casFile, '{"value":1}\n', 'utf8')
    const before = await configMutationCoordinator.read(casFile)
    writeFileSync(casFile, '{"value":2}\n', 'utf8')
    await assert.rejects(configMutationCoordinator.mutate({
      file: casFile,
      expectedHash: before.hash,
      transform: () => '{"value":3}\n'
    }), /changed|hash|concurrent/i)
    assert.equal(readFileSync(casFile, 'utf8'), '{"value":2}\n')

    // Re-open the DB like a new app process, drift a Codex setting, and prove
    // boot reconciliation restores the persisted source of truth.
    store.close()
    const reopened = new SettingsStore(join(root, 'settings.db'))
    const rebooted = new AgentSettingsService({ catalogs, repository: reopened, resolveContext })
    const codexSetting = setting(catalogs, 'codex')
    const codexSource = selectAgentConfigSource('codex', target, 'runtime', pathContext)!
    const codexCodec = codecFor(codexSource.format)
    writeFileSync(codexSource.file!, codexCodec.set(readFileSync(codexSource.file!, 'utf8'), codexSetting.path, 'drifted-model'), 'utf8')
    assert.equal((await rebooted.reconcileAll()).ok, true)
    assert.equal(codexCodec.read(readFileSync(codexSource.file!, 'utf8'), codexSetting.path).value, choices.codex.value)

    // Release restores the first captured baseline (absence), never a stale
    // intermediate value, and preserves all foreign content.
    const released = await rebooted.release('claude', target, claudeSetting.id, 'restore')
    assert.equal(released.ok, true, released.reason)
    assert.equal(claudeCodec.read(readFileSync(claudeSource.file!, 'utf8'), claudeSetting.path).present, false)
    assert(readFileSync(claudeSource.file!, 'utf8').includes(markers.claude))
    reopened.close()

    const staleCatalog = await catalogs.refresh('claude')
    assert.equal(staleCatalog?.stale, true, 'failed refresh must retain and mark the last-known-good catalog')
    const afterManualFailure = catalogFetches
    await catalogs.refreshDue()
    assert(catalogFetches > afterManualFailure, 'a stale catalog must retry before its age deadline')

    result = {
      pass: true,
      providers: AGENT_CLI_REGISTRY.length,
      counts,
      sessionShapes,
      bypassReconciled: true,
      sensitiveRedacted: true,
      remoteRefused: true,
      casRefused: true,
      rebootReconciled: true,
      codexAuthoritative: true,
      aiderRefreshUsesBothSources: true
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
