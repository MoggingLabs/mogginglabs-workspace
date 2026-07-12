import { AGENT_CLI_REGISTRY, findAgentCliDefinition } from '../../core/agent-clis'
import {
  ConfigMutationError,
  configMutationCoordinator,
  type ConfigFileSnapshot,
  type ConfigMutationCoordinator
} from '../../core/config-files'
import type {
  AgentConfigCatalog,
  AgentConfigMutationResult,
  AgentConfigObservedValue,
  AgentConfigOverrideRecord,
  AgentConfigProviderId,
  AgentConfigProviderSummary,
  AgentConfigReleaseBehavior,
  AgentConfigScopeOption,
  AgentConfigSetting,
  AgentConfigSettingState,
  AgentConfigSnapshot,
  AgentConfigSyncState,
  AgentConfigTarget,
  AgentConfigValue
} from '@contracts'
import { resolve } from 'node:path'
import { codecFor, type ConfigCodec, type JsonValue } from './codecs'
import {
  resolveAgentConfigSources,
  selectAgentConfigSource,
  type AgentConfigPathContext,
  type AgentConfigSource
} from './sources'
import { agentConfigValueContainsSecretKey, validateAgentConfigMutation } from './validation'
import { prepareAgentSessionOverlay, type PreparedAgentSessionOverlay } from './session-overlay'
import type { CodexConfigObservation, CodexConfigResolverPort, CodexConfigSettingObservation } from './codex-app-server'

export interface AgentConfigCatalogPort {
  get(provider: AgentConfigProviderId, installedVersion?: string): AgentConfigCatalog | null
  refresh?(provider: AgentConfigProviderId, installedVersion?: string): Promise<AgentConfigCatalog | null>
}

export interface AgentConfigRepository {
  listAgentConfigOverrides(filter?: {
    provider?: AgentConfigProviderId
    scope?: AgentConfigOverrideRecord['scope']
    targetId?: string
  }): AgentConfigOverrideRecord[]
  saveAgentConfigOverride(row: AgentConfigOverrideRecord): void
  removeAgentConfigOverride(key: Pick<AgentConfigOverrideRecord, 'provider' | 'scope' | 'targetId' | 'surface' | 'settingId'>): void
}

export interface AgentConfigResolvedContext {
  paths: AgentConfigPathContext
  scopes: AgentConfigScopeOption[]
}

export interface AgentSettingsServiceOptions {
  catalogs: AgentConfigCatalogPort
  repository: AgentConfigRepository
  resolveContext(provider: AgentConfigProviderId, target: AgentConfigTarget): Promise<AgentConfigResolvedContext>
  detectProvider?(provider: AgentConfigProviderId): Promise<{ installed: boolean; version?: string }>
  coordinator?: ConfigMutationCoordinator
  now?: () => number
  changed?(provider: AgentConfigProviderId, target?: AgentConfigTarget): void
  /** Authoritative Codex layer/origin resolution. Omit in offline/smoke mode. */
  codexResolver?: CodexConfigResolverPort
}

interface LoadedSource {
  source: AgentConfigSource
  snapshot?: ConfigFileSnapshot
  error?: string
}

interface PreparedRecord {
  row: AgentConfigOverrideRecord
  target: AgentConfigTarget
  setting: AgentConfigSetting
  source: AgentConfigSource
  codec: ConfigCodec
}

const sameValue = (left: AgentConfigValue | undefined, right: AgentConfigValue | undefined): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const safeError = (error: unknown): string => {
  if (error instanceof ConfigMutationError) return error.message
  return error instanceof Error && error.message ? error.message.slice(0, 240) : 'The provider config could not be updated.'
}

function mergeValues(base: AgentConfigValue | undefined, next: AgentConfigValue, concatArrays: boolean): AgentConfigValue {
  if (base === undefined) return next
  if (Array.isArray(base) && Array.isArray(next)) {
    if (!concatArrays) return next
    const out = [...base]
    for (const item of next) if (!out.some((existing) => sameValue(existing, item))) out.push(item)
    return out
  }
  if (
    base !== null && next !== null &&
    !Array.isArray(base) && !Array.isArray(next) &&
    typeof base === 'object' && typeof next === 'object'
  ) {
    const out: Record<string, AgentConfigValue> = { ...base }
    for (const [key, value] of Object.entries(next)) out[key] = mergeValues(out[key], value, concatArrays)
    return out
  }
  return next
}

function recordKey(row: Pick<AgentConfigOverrideRecord, 'provider' | 'scope' | 'targetId' | 'surface' | 'settingId'>): string {
  return [row.provider, row.scope, row.targetId, row.surface, row.settingId].join('\u0000')
}

/** Pure backend façade. Electron/path/workspace/profile facts enter through resolveContext. */
export class AgentSettingsService {
  private readonly coordinator: ConfigMutationCoordinator
  private readonly now: () => number

  constructor(private readonly options: AgentSettingsServiceOptions) {
    this.coordinator = options.coordinator ?? configMutationCoordinator
    this.now = options.now ?? Date.now
  }

  catalog(provider: AgentConfigProviderId, installedVersion?: string): AgentConfigCatalog | null {
    return this.options.catalogs.get(provider, installedVersion)
  }

  async providers(): Promise<AgentConfigProviderSummary[]> {
    return Promise.all(AGENT_CLI_REGISTRY.map(async (definition) => {
      const detected = await this.options.detectProvider?.(definition.id) ?? { installed: false }
      const catalog = this.catalog(definition.id, detected.version)
      const rows = this.options.repository.listAgentConfigOverrides({ provider: definition.id })
      const sync = this.rollup(rows.map((row) => row.status))
      return {
        provider: definition.id,
        name: definition.name,
        installed: detected.installed,
        ...(detected.version ? { version: detected.version } : {}),
        catalogVersion: catalog?.catalogVersion ?? 'unavailable',
        catalogCheckedAt: catalog?.sources.reduce((latest, source) => Math.max(latest, source.checkedAt), 0),
        catalogStale: catalog?.stale ?? true,
        enforcedCount: rows.filter((row) => row.ownership === 'enforce').length,
        sync,
        ...(!catalog ? { message: 'No validated settings catalog is available.' } : {})
      }
    }))
  }

  async snapshot(provider: AgentConfigProviderId, target: AgentConfigTarget): Promise<AgentConfigSnapshot | null> {
    const detected = await this.options.detectProvider?.(provider) ?? { installed: false }
    const catalog = this.catalog(provider, detected.version)
    const definition = findAgentCliDefinition(provider)
    if (!catalog || !definition) return null
    const resolved = await this.options.resolveContext(provider, target)
    const sources = resolveAgentConfigSources(provider, { ...resolved.paths, execution: target.execution, profile: target.scope === 'profile' })
    const loaded = await Promise.all(sources.map((source) => this.loadSource(source)))
    const overrides = this.options.repository.listAgentConfigOverrides({ provider })
    const byKey = new Map(overrides.map((row) => [recordKey(row), row]))
    let codexObservation: CodexConfigObservation | undefined
    let effectiveMessage: string | undefined
    if (provider === 'codex') {
      if (target.execution.kind !== 'local') {
        effectiveMessage = 'Codex effective values are unknown until a remote app-server adapter is connected.'
      } else if (!this.options.codexResolver) {
        effectiveMessage = 'Codex effective values are unavailable because authoritative app-server resolution is disabled.'
      } else {
        try {
          codexObservation = await this.options.codexResolver.observe({
            cwd: resolved.paths.cwd,
            env: { ...resolved.paths.env, ...resolved.paths.profileEnv },
            settings: catalog.settings
          })
        } catch {
          effectiveMessage = 'Codex effective values are unavailable because Codex app-server could not resolve the active layers.'
        }
      }
    } else if (target.execution.kind !== 'local') {
      effectiveMessage = 'Remote effective values are unknown until an SSH settings adapter is connected.'
    } else {
      effectiveMessage = 'Effective values reflect observable local layers. Provider-managed remote policy, MDM, environment variables, or external launch flags may still override them.'
    }
    const states = catalog.settings.map((setting) =>
      this.settingState(
        setting,
        target,
        loaded,
        byKey.get(recordKey({ provider, scope: target.scope, targetId: target.targetId, surface: setting.surface, settingId: setting.id })),
        codexObservation?.settings[setting.id],
        effectiveMessage
      )
    )
    return {
      provider,
      providerName: definition.name,
      installed: detected.installed,
      ...(detected.version ? { installedVersion: detected.version } : {}),
      target,
      scopes: resolved.scopes,
      catalogVersion: catalog.catalogVersion,
      catalogGeneratedAt: catalog.generatedAt,
      catalogStale: catalog.stale,
      settings: states,
      sync: this.rollup(states.map((state) => state.sync)),
      ...(effectiveMessage ? { message: effectiveMessage } : {})
    }
  }

  async set(
    provider: AgentConfigProviderId,
    target: AgentConfigTarget,
    settingId: string,
    operation: 'set' | 'unset',
    value: AgentConfigValue | undefined,
    ownership: 'once' | 'enforce'
  ): Promise<AgentConfigMutationResult> {
    const catalog = this.catalog(provider)
    const setting = catalog?.settings.find((candidate) => candidate.id === settingId)
    if (!catalog || !setting) return { ok: false, reason: 'This setting is not in the validated provider catalog.' }
    if (!setting.scopes.includes(target.scope)) return { ok: false, reason: 'The provider does not support this setting at the selected scope.' }
    if (target.scope === 'session' && operation === 'unset') return { ok: false, reason: 'A next-launch layer cannot remove a lower-precedence value. Release this override or set an explicit value instead.' }
    if (target.execution.kind !== 'local') return { ok: false, reason: 'Remote configuration is read-only until an SSH settings adapter is connected.' }
    const valid = validateAgentConfigMutation(setting, value, operation)
    if (!valid.ok) return { ok: false, reason: valid.reason }

    const context = await this.options.resolveContext(provider, target)
    const source = selectAgentConfigSource(provider, target, setting.surface, context.paths)
    if (!source?.writable) return { ok: false, reason: source?.reason || 'The selected provider layer is read-only.' }
    const prior = this.findOverride(provider, target, setting)
    let baselinePresent = prior?.baselinePresent ?? false
    let baselineValue = prior?.baselineValue
    if (!prior && source.file) {
      try {
        const current = await this.coordinator.read(source.file)
        const observed = codecFor(source.format).read(current.text, setting.path)
        baselinePresent = observed.present
        baselineValue = observed.value as AgentConfigValue | undefined
        if (baselinePresent && agentConfigValueContainsSecretKey(baselineValue)) {
          return { ok: false, reason: 'This structured value contains provider-owned authentication fields and cannot be captured as an app baseline.' }
        }
      } catch (error) {
        return { ok: false, reason: safeError(error) }
      }
    }

    const at = this.now()
    const row: AgentConfigOverrideRecord = {
      provider,
      scope: target.scope,
      targetId: target.targetId,
      surface: setting.surface,
      settingId: setting.id,
      path: [...setting.path],
      operation,
      ...(operation === 'set' ? { desiredValue: value as AgentConfigValue } : {}),
      ownership,
      baselinePresent,
      ...(baselinePresent ? { baselineValue } : {}),
      catalogVersion: catalog.catalogVersion,
      status: 'pending',
      createdAt: prior?.createdAt ?? at,
      updatedAt: at
    }
    this.options.repository.saveAgentConfigOverride(row)
    const result = await this.reconcileRows([row])
    if (result.ok && ownership === 'once' && source.file) this.options.repository.removeAgentConfigOverride(row)
    this.options.changed?.(provider, target)
    return result
  }

  async release(
    provider: AgentConfigProviderId,
    target: AgentConfigTarget,
    settingId: string,
    behavior: AgentConfigReleaseBehavior
  ): Promise<AgentConfigMutationResult> {
    const row = this.options.repository
      .listAgentConfigOverrides({ provider, scope: target.scope, targetId: target.targetId })
      .find((candidate) => candidate.settingId === settingId)
    if (!row) return { ok: true }
    if (behavior === 'keep' || target.scope === 'session') {
      this.options.repository.removeAgentConfigOverride(row)
      this.options.changed?.(provider, target)
      return { ok: true }
    }
    if (target.execution.kind !== 'local') return { ok: false, reason: 'A remote baseline cannot be restored locally.' }
    const context = await this.options.resolveContext(provider, target)
    const source = selectAgentConfigSource(provider, target, row.surface, context.paths)
    if (!source?.file || !source.writable) return { ok: false, reason: source?.reason || 'The original layer is no longer writable.' }
    const codec = codecFor(source.format)
    try {
      const before = await this.coordinator.read(source.file)
      if (!row.baselinePresent && before.text === null) {
        this.options.repository.removeAgentConfigOverride(row)
        this.options.changed?.(provider, target)
        return { ok: true }
      }
      await this.coordinator.mutate({
        file: source.file,
        expectedHash: before.hash,
        transform: (current) => row.baselinePresent
          ? codec.set(current.text, row.path, row.baselineValue as JsonValue)
          : current.text === null ? '{}\n' : codec.remove(current.text, row.path),
        validate: (text) => codec.validate(text)
      })
      if (provider === 'codex') this.options.codexResolver?.invalidate?.()
      this.options.repository.removeAgentConfigOverride(row)
      this.options.changed?.(provider, target)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: safeError(error) }
    }
  }

  async reconcileAll(): Promise<AgentConfigMutationResult> {
    return this.reconcileRows(this.options.repository.listAgentConfigOverrides().filter((row) => row.ownership === 'enforce'))
  }

  async reconcileTarget(provider: AgentConfigProviderId, target: AgentConfigTarget): Promise<AgentConfigMutationResult> {
    if (target.execution.kind !== 'local') return { ok: false, reason: 'Remote configuration cannot be reconciled locally.' }
    const rows = this.options.repository
      .listAgentConfigOverrides({ provider, scope: target.scope, targetId: target.targetId })
      .filter((row) => row.ownership === 'enforce')
    return this.reconcileRows(rows)
  }

  async reconcileLaunch(
    provider: AgentConfigProviderId,
    targetIds: { workspaceId?: string; profileId?: string; profileReplacesUser?: boolean; cwd?: string }
  ): Promise<AgentConfigMutationResult> {
    const rows = this.options.repository.listAgentConfigOverrides({ provider }).filter((row) => {
      if (row.ownership !== 'enforce') return false
      if (row.scope === 'user') return !targetIds.profileReplacesUser
      if (row.scope === 'system-default' || row.scope === 'system-policy') return true
      if (row.scope === 'profile') return !!targetIds.profileId && row.targetId === targetIds.profileId
      return !!targetIds.workspaceId && row.targetId === targetIds.workspaceId
    })
    if (provider === 'claude' && targetIds.workspaceId && targetIds.cwd && rows.some((row) => row.scope === 'project' || row.scope === 'local')) {
      const context = await this.options.resolveContext(provider, {
        scope: 'project',
        targetId: targetIds.workspaceId,
        execution: { kind: 'local' }
      })
      if (!context.paths.cwd || resolve(context.paths.cwd) !== resolve(targetIds.cwd)) {
        return { ok: false, reason: 'Claude project settings are scoped to the exact launch directory. Launch from the configured workspace root or create a matching workspace target.' }
      }
    }
    return this.reconcileRows(rows)
  }

  prepareSession(provider: AgentConfigProviderId, targetId: string): PreparedAgentSessionOverlay {
    const catalog = this.catalog(provider)
    if (!catalog) return { runtime: {}, tui: {}, args: [], env: {}, settingIds: [], issues: ['No validated settings catalog is available.'] }
    return prepareAgentSessionOverlay(provider, this.sessionRows(provider, targetId), catalog)
  }

  sessionRows(provider: AgentConfigProviderId, targetId: string): AgentConfigOverrideRecord[] {
    return this.options.repository.listAgentConfigOverrides({ provider, scope: 'session', targetId })
  }

  markSessionLaunched(provider: AgentConfigProviderId, targetId: string): void {
    for (const row of this.sessionRows(provider, targetId)) {
      if (row.ownership === 'once') this.options.repository.removeAgentConfigOverride(row)
      else this.options.repository.saveAgentConfigOverride({ ...row, status: 'synced', appliedAt: this.now(), updatedAt: this.now() })
    }
  }

  private async reconcileRows(rows: AgentConfigOverrideRecord[]): Promise<AgentConfigMutationResult> {
    if (!rows.length) return { ok: true }
    const prepared: PreparedRecord[] = []
    const session: AgentConfigOverrideRecord[] = []
    let failure: string | undefined

    for (const row of rows) {
      const target: AgentConfigTarget = { scope: row.scope, targetId: row.targetId, execution: { kind: 'local' } }
      const catalog = this.catalog(row.provider)
      const setting = catalog?.settings.find((candidate) => candidate.id === row.settingId)
      const validation = setting
        ? validateAgentConfigMutation(setting, row.desiredValue, row.operation)
        : { ok: false, reason: 'The catalog entry is missing.' }
      if (!setting || JSON.stringify(setting.path) !== JSON.stringify(row.path) || !validation.ok) {
        const reason = 'The intent no longer matches a writable, non-secret catalog setting.'
        this.saveStatus(row, 'unsupported', reason)
        failure ??= reason
        continue
      }
      if (row.scope === 'session') {
        session.push(row)
        continue
      }
      try {
        const context = await this.options.resolveContext(row.provider, target)
        const source = selectAgentConfigSource(row.provider, target, row.surface, context.paths)
        if (!source?.file || !source.writable) {
          const reason = source?.reason || 'The selected layer is unavailable.'
          this.saveStatus(row, 'blocked', reason)
          failure ??= reason
          continue
        }
        prepared.push({ row, target, setting, source, codec: codecFor(source.format) })
      } catch (error) {
        const reason = safeError(error)
        this.saveStatus(row, 'error', reason)
        failure ??= reason
      }
    }

    for (const row of session) this.saveStatus(row, 'pending-restart', 'This value applies to the next app-launched session.')

    const groups = new Map<string, PreparedRecord[]>()
    for (const item of prepared) {
      const key = `${item.source.format}\u0000${item.source.file}`
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }

    for (const group of groups.values()) {
      const first = group[0]
      try {
        const before = await this.coordinator.read(first.source.file!)
        if (before.text === null && group.every((item) => item.row.operation === 'unset')) {
          const at = this.now()
          for (const item of group) {
            this.options.repository.saveAgentConfigOverride({
              ...item.row,
              status: item.setting.activation === 'live' ? 'synced' : 'pending-restart',
              lastAppliedHash: undefined,
              lastError: undefined,
              updatedAt: at,
              appliedAt: at
            })
          }
          continue
        }
        const result = await this.coordinator.mutate({
          file: first.source.file!,
          expectedHash: before.hash,
          transform: (current) => {
            let text = current.text
            for (const item of group) {
              text = item.row.operation === 'set'
                ? item.codec.set(text, item.row.path, item.row.desiredValue as JsonValue)
                : text === null ? this.emptyDocument(item.codec) : item.codec.remove(text, item.row.path)
            }
            return text ?? this.emptyDocument(first.codec)
          },
          validate: (text) => first.codec.validate(text)
        })
        const at = this.now()
        for (const item of group) {
          this.options.repository.saveAgentConfigOverride({
            ...item.row,
            status: item.setting.activation === 'live' ? 'synced' : 'pending-restart',
            lastAppliedValue: item.row.operation === 'set' ? item.row.desiredValue : undefined,
            lastAppliedHash: result.hash ?? undefined,
            lastError: undefined,
            updatedAt: at,
            appliedAt: at
          })
          this.options.changed?.(item.row.provider, item.target)
        }
        if (group.some((item) => item.row.provider === 'codex')) this.options.codexResolver?.invalidate?.()
      } catch (error) {
        const reason = safeError(error)
        failure ??= reason
        for (const item of group) this.saveStatus(item.row, 'error', reason)
      }
    }
    return failure ? { ok: false, reason: failure } : { ok: true }
  }

  private async loadSource(source: AgentConfigSource): Promise<LoadedSource> {
    if (source.constraintOnly) return { source }
    if (source.inlineText !== undefined) {
      if (Buffer.byteLength(source.inlineText, 'utf8') > 2 * 1024 * 1024) return { source, error: 'The inline provider configuration is too large.' }
      return {
        source,
        snapshot: {
          text: source.inlineText,
          hash: null,
          bom: source.inlineText.startsWith('\uFEFF'),
          eol: source.inlineText.includes('\r\n') ? '\r\n' : '\n',
          trailingNewline: /\r?\n$/.test(source.inlineText)
        }
      }
    }
    if (!source.file) return { source }
    try {
      return { source, snapshot: await this.coordinator.read(source.file) }
    } catch (error) {
      return { source, error: safeError(error) }
    }
  }

  private settingState(
    setting: AgentConfigSetting,
    target: AgentConfigTarget,
    sources: LoadedSource[],
    desired: AgentConfigOverrideRecord | undefined,
    codexObservation?: CodexConfigSettingObservation,
    effectiveMessage?: string
  ): AgentConfigSettingState {
    const selectedCandidates = [...sources].reverse().filter((loaded) =>
      loaded.source.scope === target.scope && loaded.source.surface === setting.surface)
    let selectedSource = selectedCandidates[0]
    let selected: AgentConfigObservedValue
    if (selectedSource?.source.scope === 'session' && desired) {
      selected = desired.operation === 'set'
        ? setting.sensitive
          ? { present: true, redacted: true, known: true, sourceLabel: selectedSource.source.label, sourceScope: 'session' }
          : { present: true, value: desired.desiredValue, known: true, sourceLabel: selectedSource.source.label, sourceScope: 'session' }
        : { present: false, known: true, sourceLabel: selectedSource.source.label, sourceScope: 'session' }
    } else {
      selected = this.observe(setting, selectedSource)
      for (const candidate of selectedCandidates) {
        const observed = this.observe(setting, candidate)
        if (candidate.error || observed.present) {
          selectedSource = candidate
          selected = observed
          break
        }
      }
    }
    if (target.execution.kind !== 'local') selected = { present: false, known: false }
    let effectiveValue: AgentConfigValue | undefined
    let effectiveSource: AgentConfigSource | undefined
    let effectiveKnown = false
    let parseError = sources.some((loaded) => !!loaded.error)

    if (setting.provider === 'codex') {
      let effective: AgentConfigObservedValue = codexObservation?.effective ?? { present: false, known: false }
      if (codexObservation && !codexObservation.constrained && target.scope === 'session' && desired?.operation === 'set') {
        effective = setting.sensitive || agentConfigValueContainsSecretKey(desired.desiredValue)
          ? { present: true, redacted: true, known: true, sourceLabel: 'Next launch', sourceScope: 'session' }
          : { present: true, value: desired.desiredValue, known: true, sourceLabel: 'Next launch', sourceScope: 'session' }
      }
      let sync: AgentConfigSyncState = desired?.status ?? (parseError ? 'parse-error' : 'observed')
      if (desired?.ownership === 'enforce' && !setting.sensitive && !selectedSource?.error) {
        const matches = desired.operation === 'unset'
          ? !selected.present
          : selected.present && sameValue(selected.value, desired.desiredValue)
        sync = matches ? (setting.activation === 'live' ? 'synced' : 'pending-restart') : 'drifted'
        if (matches && effective.known && desired.operation === 'set' && !sameValue(effective.value, desired.desiredValue)) sync = 'shadowed'
      }
      return {
        setting,
        selected,
        effective,
        ...(desired ? { desired: { operation: desired.operation, ...(desired.operation === 'set' ? { value: desired.desiredValue } : {}), ownership: desired.ownership, updatedAt: desired.updatedAt } } : {}),
        sync,
        ...(codexObservation?.constrained ? { constrained: true } : {}),
        ...(selectedSource?.error ? { message: selectedSource.error } : desired?.lastError ? { message: desired.lastError } : effectiveMessage ? { message: effectiveMessage } : {})
      }
    }

    for (const loaded of sources) {
      if (loaded.source.surface !== setting.surface || loaded.source.constraintOnly) continue
      if (loaded.error) {
        parseError = true
        continue
      }
      if (loaded.source.scope === 'session') {
        if (target.scope !== 'session' || !desired) continue
        if (desired.operation === 'unset') continue
        effectiveValue = desired.desiredValue
        effectiveSource = loaded.source
        effectiveKnown = true
        continue
      }
      if (!loaded.snapshot || loaded.snapshot.text === null) continue
      try {
        const read = codecFor(loaded.source.format).read(loaded.snapshot.text, setting.path)
        if (!read.present) continue
        effectiveValue = mergeValues(effectiveValue, read.value as AgentConfigValue, loaded.source.merge === 'deep-concat-arrays')
        effectiveSource = loaded.source
        effectiveKnown = true
      } catch {
        parseError = true
      }
    }
    if (target.execution.kind === 'local' && !effectiveKnown && setting.defaultValue !== undefined) {
      effectiveValue = setting.defaultValue
      effectiveKnown = true
    }
    const effectiveSensitive = setting.sensitive || agentConfigValueContainsSecretKey(effectiveValue)
    const effective: AgentConfigObservedValue = effectiveSensitive
      ? { present: effectiveKnown, redacted: effectiveKnown, known: effectiveKnown, ...(effectiveSource ? { sourceLabel: effectiveSource.label, sourceScope: effectiveSource.scope } : { sourceLabel: 'Provider default' }) }
      : { present: effectiveKnown, ...(effectiveKnown ? { value: effectiveValue } : {}), known: effectiveKnown, ...(effectiveSource ? { sourceLabel: effectiveSource.label, sourceScope: effectiveSource.scope } : effectiveKnown ? { sourceLabel: 'Provider default' } : {}) }

    let sync: AgentConfigSyncState = desired?.status ?? (parseError ? 'parse-error' : 'observed')
    if (desired?.ownership === 'enforce' && !setting.sensitive && !selectedSource?.error) {
      const matches = desired.operation === 'unset'
        ? !selected.present
        : selected.present && sameValue(selected.value, desired.desiredValue)
      sync = matches ? (setting.activation === 'live' ? 'synced' : 'pending-restart') : 'drifted'
      if (matches && effective.known && desired.operation === 'set' && !sameValue(effective.value, desired.desiredValue)) sync = 'shadowed'
    }
    return {
      setting,
      selected,
      effective,
      ...(desired ? { desired: { operation: desired.operation, ...(desired.operation === 'set' ? { value: desired.desiredValue } : {}), ownership: desired.ownership, updatedAt: desired.updatedAt } } : {}),
      sync,
      ...(selectedSource?.error ? { message: selectedSource.error } : desired?.lastError ? { message: desired.lastError } : {})
    }
  }

  private observe(setting: AgentConfigSetting, loaded: LoadedSource | undefined): AgentConfigObservedValue {
    if (!loaded) return { present: false, known: false }
    if (loaded.error) return { present: false, known: false }
    if (loaded.source.scope === 'session') return { present: false, known: true, sourceLabel: loaded.source.label, sourceScope: loaded.source.scope }
    if (!loaded.snapshot || loaded.snapshot.text === null) return { present: false, known: true, sourceLabel: loaded.source.label, sourceScope: loaded.source.scope }
    try {
      const read = codecFor(loaded.source.format).read(loaded.snapshot.text, setting.path)
      if (setting.sensitive || agentConfigValueContainsSecretKey(read.value as AgentConfigValue | undefined)) {
        return { present: read.present, redacted: read.present, known: true, sourceLabel: loaded.source.label, sourceScope: loaded.source.scope }
      }
      return { present: read.present, ...(read.present ? { value: read.value as AgentConfigValue } : {}), known: true, sourceLabel: loaded.source.label, sourceScope: loaded.source.scope }
    } catch {
      return { present: false, known: false }
    }
  }

  private findOverride(provider: AgentConfigProviderId, target: AgentConfigTarget, setting: AgentConfigSetting): AgentConfigOverrideRecord | undefined {
    return this.options.repository
      .listAgentConfigOverrides({ provider, scope: target.scope, targetId: target.targetId })
      .find((row) => row.surface === setting.surface && row.settingId === setting.id)
  }

  private saveStatus(row: AgentConfigOverrideRecord, status: AgentConfigSyncState, message: string): void {
    this.options.repository.saveAgentConfigOverride({ ...row, status, lastError: message, updatedAt: this.now() })
  }

  private emptyDocument(codec: ConfigCodec): string {
    return codec.kind === 'yaml' ? '' : codec.kind === 'toml' ? '' : '{}\n'
  }

  private rollup(states: AgentConfigSyncState[]): AgentConfigSyncState {
    if (states.some((state) => state === 'error' || state === 'parse-error')) return 'error'
    if (states.some((state) => state === 'blocked' || state === 'unsupported')) return 'blocked'
    if (states.some((state) => state === 'drifted')) return 'drifted'
    if (states.some((state) => state === 'shadowed')) return 'shadowed'
    if (states.some((state) => state === 'pending' || state === 'pending-restart')) return 'pending'
    if (states.some((state) => state === 'synced')) return 'synced'
    return 'observed'
  }
}
