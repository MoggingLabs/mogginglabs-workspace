import { app, ipcMain, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  AgentSettingsCatalogService,
  AgentSettingsService,
  CodexAppServerConfigResolver,
  type AgentConfigResolvedContext,
  type PreparedAgentSessionOverlay
} from '@backend/features/agent-settings'
import { AGENT_CLI_REGISTRY, findAgentCliDefinition } from '@backend/core/agent-clis'
import { detectAgents } from '@backend/features/agents'
import {
  AgentConfigChannels,
  isAgentCliId,
  isAgentExecutionTarget,
  type AgentCliId,
  type AgentCommandRequest,
  type AgentConfigProviderId,
  type AgentConfigRefreshRequest,
  type AgentConfigReleaseRequest,
  type AgentConfigScope,
  type AgentConfigScopeOption,
  type AgentConfigSetRequest,
  type AgentConfigSnapshotRequest,
  type AgentConfigTarget,
  type AgentConfigValue
} from '@contracts'
import { getSettingsStore } from './app-settings'

const scopes = new Set<AgentConfigScope>([
  'session', 'project', 'local', 'profile', 'user', 'system-default', 'system-policy'
])
const targetIdShape = /^[^\u0000-\u001f]{1,128}$/
const versionCache = new Map<AgentCliId, { at: number; installed: boolean; version?: string }>()
let catalogs: AgentSettingsCatalogService | null = null
let settings: AgentSettingsService | null = null
let offlineMode = false
let isolatedSettingsHome: string | undefined
let catalogTimer: ReturnType<typeof setInterval> | undefined
let startupCatalogTimer: ReturnType<typeof setTimeout> | undefined
let settingsWindow: (() => BrowserWindow | null) | undefined

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeTarget(value: unknown): AgentConfigTarget | null {
  const raw = record(value)
  if (!raw || !scopes.has(raw.scope as AgentConfigScope) || typeof raw.targetId !== 'string' || !targetIdShape.test(raw.targetId)) return null
  if (!isAgentExecutionTarget(raw.execution)) return null
  return { scope: raw.scope as AgentConfigScope, targetId: raw.targetId, execution: raw.execution }
}

function safeValue(value: unknown, depth = 0): value is AgentConfigValue {
  if (depth > 12 || value === undefined || typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 2048 && value.every((entry) => safeValue(entry, depth + 1))
  const raw = record(value)
  return !!raw && Object.keys(raw).length <= 2048 && Object.entries(raw).every(([key, entry]) =>
    !!key && key.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(key) && safeValue(entry, depth + 1)
  )
}

function sameTarget(left: AgentConfigTarget, right: AgentConfigTarget): boolean {
  return left.scope === right.scope && left.targetId === right.targetId &&
    left.execution.kind === right.execution.kind &&
    (left.execution.kind !== 'ssh' || right.execution.kind === 'ssh' && left.execution.hostId === right.execution.hostId)
}

function option(
  target: AgentConfigTarget,
  label: string,
  description: string,
  writable: boolean,
  selected: AgentConfigTarget,
  reason?: string
): AgentConfigScopeOption {
  return {
    target,
    label,
    description,
    writable,
    ...(reason ? { reason } : {}),
    ...(sameTarget(target, selected) ? { selectedByDefault: true } : {})
  }
}

function scopeOptions(provider: AgentConfigProviderId, selected: AgentConfigTarget): AgentConfigScopeOption[] {
  const store = getSettingsStore()
  const state = store?.load()
  const definition = findAgentCliDefinition(provider)
  if (!definition) return []
  const supported = new Set<AgentConfigScope>(definition.config.scopes)
  const out: AgentConfigScopeOption[] = []
  const local = { kind: 'local' } as const

  if (supported.has('user')) out.push(option({ scope: 'user', targetId: 'default', execution: local }, 'All projects', 'The provider user configuration on this machine.', true, selected))
  for (const workspace of state?.workspaces ?? []) {
    if (supported.has('project')) out.push(option({ scope: 'project', targetId: workspace.id, execution: local }, workspace.name, `Shared project settings in ${workspace.cwd}.`, true, selected))
    if (supported.has('local')) out.push(option({ scope: 'local', targetId: workspace.id, execution: local }, `${workspace.name} — private`, 'Machine-local project settings.', true, selected))
    if (supported.has('session')) out.push(option({ scope: 'session', targetId: workspace.id, execution: local }, `${workspace.name} — next launch`, 'An app-launched session overlay; provider files stay untouched.', true, selected))
    const remoteIds = new Set((workspace.remotes ?? []).map((remote) => remote?.hostId).filter((id): id is string => !!id))
    for (const hostId of remoteIds) {
      const remote = store?.listRemotes().find((candidate) => candidate.id === hostId)
      if (supported.has('project')) out.push(option(
        { scope: 'project', targetId: workspace.id, execution: { kind: 'ssh', hostId } },
        `${workspace.name} on ${remote?.name ?? hostId}`,
        'Remote values are not guessed from local files.',
        false,
        selected,
        'SSH settings are read-only until a remote configuration adapter is connected.'
      ))
    }
  }
  if (supported.has('profile')) {
    const pointer = definition.config.pointerEnv
    for (const profile of store?.listProfiles().filter((candidate) =>
      candidate.provider === provider && !!pointer && (!!candidate.env[pointer] || provider === 'gemini' && !!candidate.env.GEMINI_CONFIG_DIR)
    ) ?? []) {
      out.push(option({ scope: 'profile', targetId: profile.id, execution: local }, `Profile — ${profile.name}`, 'The configuration home used by this subscription profile.', true, selected))
    }
  }
  if (supported.has('system-default')) out.push(option({ scope: 'system-default', targetId: 'default', execution: local }, 'System defaults', 'Administrator-provided defaults, shown read-only.', false, selected, 'System files require administrator ownership.'))
  if (supported.has('system-policy')) out.push(option({ scope: 'system-policy', targetId: 'default', execution: local }, 'Managed policy', 'Enterprise policy and constraints, shown read-only.', false, selected, 'Managed policy remains administrator-owned.'))
  return out
}

function defaultTarget(): AgentConfigTarget {
  return { scope: 'user', targetId: 'default', execution: { kind: 'local' } }
}

async function resolveContext(provider: AgentConfigProviderId, target: AgentConfigTarget): Promise<AgentConfigResolvedContext> {
  const store = getSettingsStore()
  const definition = findAgentCliDefinition(provider)
  if (!store || !definition || !definition.config.scopes.includes(target.scope)) throw new Error('The selected provider scope is unavailable.')
  const state = store.load()
  let cwd: string | undefined
  let profileEnv: Record<string, string> | undefined

  if (target.scope === 'project' || target.scope === 'local' || target.scope === 'session') {
    const workspace = state.workspaces.find((candidate) => candidate.id === target.targetId)
    if (!workspace) throw new Error('The selected workspace no longer exists.')
    cwd = workspace.cwd
  } else if (target.scope === 'profile') {
    const profile = store.listProfiles().find((candidate) => candidate.id === target.targetId && candidate.provider === provider)
    if (!profile) throw new Error('The selected provider profile no longer exists.')
    const pointer = definition.config.pointerEnv
    if (!pointer || (!profile.env[pointer] && !(provider === 'gemini' && profile.env.GEMINI_CONFIG_DIR))) {
      throw new Error('This default profile shares the all-projects provider configuration.')
    }
    profileEnv = profile.env
  } else if (target.targetId !== 'default') {
    throw new Error('This scope does not accept a named target.')
  }

  if (target.execution.kind === 'ssh') {
    const hostId = target.execution.hostId
    if (!store.listRemotes().some((remote) => remote.id === hostId)) throw new Error('The selected SSH host no longer exists.')
  }
  return {
    paths: {
      home: isolatedSettingsHome ?? app.getPath('home'),
      cwd,
      platform: process.platform,
      env: isolatedSettingsHome
        ? {
            ...process.env,
            APPDATA: join(isolatedSettingsHome, 'AppData', 'Roaming'),
            XDG_CONFIG_HOME: join(isolatedSettingsHome, '.config')
          }
        : process.env,
      profileEnv,
      profile: target.scope === 'profile',
      execution: target.execution
    },
    scopes: scopeOptions(provider, target)
  }
}

async function providerInstallation(provider: AgentCliId, force = false): Promise<{ installed: boolean; version?: string }> {
  const cached = versionCache.get(provider)
  if (!force && cached && Date.now() - cached.at < 60_000) return cached
  const installed = detectAgents().find((agent) => agent.id === provider)?.installed ?? false
  if (!installed) {
    const result = { at: Date.now(), installed: false }
    versionCache.set(provider, result)
    return result
  }
  if (offlineMode) {
    const result = { at: Date.now(), installed: true }
    versionCache.set(provider, result)
    return result
  }
  const definition = findAgentCliDefinition(provider)
  if (!definition) return { installed: false }
  const version = await new Promise<string | undefined>((resolve) => {
    let output = ''
    let settled = false
    const done = (value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(definition.bin, [...definition.versionArgs], {
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const collect = (chunk: Buffer): void => { if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => done())
    child.on('close', () => {
      const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ').replace(/\s+/g, ' ').trim()
      done(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(clean)?.[0])
    })
    const timer = setTimeout(() => {
      child.kill()
      done()
    }, 3_000)
  })
  const result = { at: Date.now(), installed: true, ...(version ? { version } : {}) }
  versionCache.set(provider, result)
  return result
}

function emitChanged(getWin: () => BrowserWindow | null, provider: AgentConfigProviderId, target?: AgentConfigTarget): void {
  try {
    getWin()?.webContents.send(AgentConfigChannels.changed, { provider, ...(target ? { target } : {}) })
  } catch {
    // A later snapshot catches a newly mounted/recreated window up.
  }
}

export interface PreparedAgentConfigLaunch extends PreparedAgentSessionOverlay {
  ok: boolean
  reason?: string
}

const launchReconcileTimeoutMs = 8_000

export async function prepareAgentConfigLaunch(req: AgentCommandRequest): Promise<PreparedAgentConfigLaunch> {
  const empty: PreparedAgentSessionOverlay = { runtime: {}, tui: {}, args: [], env: {}, settingIds: [], issues: [] }
  if (req.execution?.kind === 'ssh') return { ok: true, ...empty }
  if (!settings) return { ok: false, ...empty, reason: 'Provider settings are not ready; retry the launch.' }
  const profile = req.profileId
    ? getSettingsStore()?.listProfiles().find((candidate) => candidate.id === req.profileId && candidate.provider === req.agentId)
    : undefined
  const pointer = findAgentCliDefinition(req.agentId)?.config.pointerEnv
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'Provider settings synchronization timed out; retry the launch.' }), launchReconcileTimeoutMs)
    timer.unref?.()
  })
  const reconciled = await Promise.race([
    settings.reconcileLaunch(req.agentId, {
      workspaceId: req.workspaceId,
      profileId: req.profileId,
      profileReplacesUser: !!(profile && pointer && (profile.env[pointer] || req.agentId === 'gemini' && profile.env.GEMINI_CONFIG_DIR)),
      cwd: req.cwd
    }),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  if (!reconciled.ok) return { ok: false, ...empty, reason: reconciled.reason || 'Saved provider settings could not be synchronized.' }
  const prepared = settings.prepareSession(req.agentId, req.workspaceId ?? 'default')
  if (prepared.issues.length) return { ok: false, ...prepared, reason: prepared.issues[0] }
  return { ok: true, ...prepared }
}

export function markAgentConfigSessionLaunched(req: AgentCommandRequest): void {
  settings?.markSessionLaunched(req.agentId, req.workspaceId ?? 'default')
}

export async function refreshAgentSettingsForCli(provider: AgentCliId): Promise<void> {
  if (offlineMode || !catalogs || !settings) return
  versionCache.delete(provider)
  const detected = await providerInstallation(provider, true)
  await catalogs.refresh(provider, detected.version)
  await settings.reconcileAll()
  if (settingsWindow) emitChanged(settingsWindow, provider)
}

export async function registerAgentSettings(getWin: () => BrowserWindow | null, offline = false): Promise<void> {
  const store = getSettingsStore()
  if (!store) throw new Error('Agent settings require the app settings store.')
  offlineMode = offline
  isolatedSettingsHome = offline ? join(app.getPath('userData'), 'agent-settings-home') : undefined
  settingsWindow = getWin
  catalogs = new AgentSettingsCatalogService({ cacheFile: join(app.getPath('userData'), 'agent-settings', 'catalog.json') })
  settings = new AgentSettingsService({
    catalogs,
    repository: store,
    resolveContext,
    detectProvider: (provider) => providerInstallation(provider),
    ...(!offlineMode ? { codexResolver: new CodexAppServerConfigResolver({ clientVersion: app.getVersion() }) } : {}),
    changed: (provider, target) => emitChanged(getWin, provider, target)
  })

  ipcMain.handle(AgentConfigChannels.providers, () => settings?.providers() ?? [])
  ipcMain.handle(AgentConfigChannels.catalog, async (_event, raw: unknown) => {
    const request = record(raw)
    if (!request || !isAgentCliId(request.provider)) return null
    const detected = await providerInstallation(request.provider)
    return settings?.catalog(request.provider, detected.version) ?? null
  })
  ipcMain.handle(AgentConfigChannels.snapshot, async (_event, raw: AgentConfigSnapshotRequest) => {
    const request = record(raw)
    if (!request || !isAgentCliId(request.provider)) return null
    const target = request.target === undefined ? defaultTarget() : safeTarget(request.target)
    if (!target) return null
    try {
      return await settings?.snapshot(request.provider, target) ?? null
    } catch {
      return null
    }
  })
  ipcMain.handle(AgentConfigChannels.set, async (_event, raw: AgentConfigSetRequest) => {
    const request = record(raw)
    const target = safeTarget(request?.target)
    if (!request || !isAgentCliId(request.provider) || !target || typeof request.settingId !== 'string' || request.settingId.length > 512 ||
      !['set', 'unset'].includes(String(request.operation)) || !['once', 'enforce'].includes(String(request.ownership)) ||
      (request.operation === 'set' && !safeValue(request.value))) return { ok: false, reason: 'Invalid settings request.' }
    return settings?.set(
      request.provider,
      target,
      request.settingId,
      request.operation as 'set' | 'unset',
      request.value as AgentConfigValue | undefined,
      request.ownership as 'once' | 'enforce'
    ) ?? { ok: false, reason: 'Agent settings are unavailable.' }
  })
  ipcMain.handle(AgentConfigChannels.release, async (_event, raw: AgentConfigReleaseRequest) => {
    const request = record(raw)
    const target = safeTarget(request?.target)
    if (!request || !isAgentCliId(request.provider) || !target || typeof request.settingId !== 'string' || request.settingId.length > 512 ||
      !['keep', 'restore'].includes(String(request.behavior))) return { ok: false, reason: 'Invalid release request.' }
    return settings?.release(request.provider, target, request.settingId, request.behavior as 'keep' | 'restore') ??
      { ok: false, reason: 'Agent settings are unavailable.' }
  })
  ipcMain.handle(AgentConfigChannels.refresh, async (_event, raw: AgentConfigRefreshRequest) => {
    const request = raw === undefined ? {} : record(raw)
    if (!request || (request.provider !== undefined && !isAgentCliId(request.provider))) return { ok: false, refreshed: [], reason: 'Invalid provider.' }
    const ids = request.provider ? [request.provider] : AGENT_CLI_REGISTRY.map(({ id }) => id)
    const refreshed: AgentConfigProviderId[] = []
    for (const id of ids) {
      const detected = await providerInstallation(id, request.force === true)
      const catalog = await catalogs?.refresh(id, detected.version)
      if (catalog && !catalog.stale) refreshed.push(id)
      emitChanged(getWin, id)
    }
    await settings?.reconcileAll()
    return refreshed.length === ids.length
      ? { ok: true, refreshed }
      : { ok: false, refreshed, reason: 'One or more providers kept their last-known-good catalog.' }
  })

  // The bundled catalog is already in memory; load the LKG cache and reconcile
  // enforced values now, but keep five executable/version probes off the first
  // interaction path. Launch reconciliation remains independently fail-closed.
  await catalogs.initialize({}, false)
  const reconciled = await settings.reconcileAll()
  if (!reconciled.ok) console.warn(`[agent-settings] startup reconciliation incomplete: ${reconciled.reason}`)
  if (!offlineMode) {
    const refreshInstalledCatalogs = async (forceDetection: boolean): Promise<void> => {
      const versions: Partial<Record<AgentConfigProviderId, string>> = {}
      await Promise.all(AGENT_CLI_REGISTRY.map(async ({ id }) => {
        const version = (await providerInstallation(id, forceDetection)).version
        if (version) versions[id] = version
      }))
      await catalogs?.refreshDue(versions)
      await settings?.reconcileAll()
      for (const { id } of AGENT_CLI_REGISTRY) emitChanged(getWin, id)
    }
    startupCatalogTimer = setTimeout(() => {
      startupCatalogTimer = undefined
      void refreshInstalledCatalogs(false).catch(() => console.warn('[agent-settings] background catalog refresh failed'))
    }, 10_000)
    startupCatalogTimer.unref?.()
    catalogTimer = setInterval(() => {
      void refreshInstalledCatalogs(true).catch(() => console.warn('[agent-settings] periodic catalog refresh failed'))
    }, 60 * 60 * 1_000)
    catalogTimer.unref?.()
  }
}

export function disposeAgentSettings(): void {
  for (const channel of [
    AgentConfigChannels.providers,
    AgentConfigChannels.catalog,
    AgentConfigChannels.snapshot,
    AgentConfigChannels.set,
    AgentConfigChannels.release,
    AgentConfigChannels.refresh
  ]) ipcMain.removeHandler(channel)
  versionCache.clear()
  if (startupCatalogTimer) clearTimeout(startupCatalogTimer)
  startupCatalogTimer = undefined
  if (catalogTimer) clearInterval(catalogTimer)
  catalogTimer = undefined
  settingsWindow = undefined
  settings = null
  catalogs = null
  offlineMode = false
  isolatedSettingsHome = undefined
}
