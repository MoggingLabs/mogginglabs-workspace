import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import type {
  AgentConfigObservedValue,
  AgentConfigScope,
  AgentConfigSetting,
  AgentConfigValue
} from '@contracts'
import { agentConfigValueContainsSecretKey } from './validation'

export interface CodexConfigObservationRequest {
  cwd?: string
  env?: NodeJS.ProcessEnv
  settings: readonly AgentConfigSetting[]
}

export interface CodexConfigSettingObservation {
  effective: AgentConfigObservedValue
  constrained: boolean
}

/**
 * The app-server response is reduced to validated catalog ids before leaving
 * the adapter. In particular, provider file paths and secret-shaped values do
 * not appear in this interface.
 */
export interface CodexConfigObservation {
  settings: Readonly<Record<string, CodexConfigSettingObservation>>
}

export interface CodexConfigResolverPort {
  observe(request: CodexConfigObservationRequest): Promise<CodexConfigObservation>
  invalidate?(): void
}

export interface CodexAppServerResolverOptions {
  bin?: string
  clientVersion?: string
  timeoutMs?: number
  cacheMs?: number
  maxOutputBytes?: number
}

interface JsonRecord {
  [key: string]: unknown
}

interface RawAppServerObservation {
  config: JsonRecord
  origins: JsonRecord
  requirements: JsonRecord | null
}

interface SafeOrigin {
  sourceLabel: string
  sourceScope?: AgentConfigScope
}

interface CacheEntry {
  expiresAt: number
  value: Promise<RawAppServerObservation>
}

const DEFAULT_TIMEOUT_MS = 4_000
const DEFAULT_CACHE_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_VALUE_DEPTH = 16
const originPathShape = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function jsonValue(value: unknown, depth = 0): value is AgentConfigValue {
  if (depth > MAX_VALUE_DEPTH) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 4096 && value.every((item) => jsonValue(item, depth + 1))
  const object = record(value)
  return !!object && Object.keys(object).length <= 4096 && Object.entries(object).every(([key, item]) =>
    key.length > 0 && key.length <= 512 && !['__proto__', 'prototype', 'constructor'].includes(key) && jsonValue(item, depth + 1)
  )
}

function valueAt(root: JsonRecord, path: readonly string[]): { present: boolean; value?: AgentConfigValue } {
  let current: unknown = root
  for (const segment of path) {
    const object = record(current)
    if (!object || !Object.prototype.hasOwnProperty.call(object, segment)) return { present: false }
    current = object[segment]
  }
  return jsonValue(current) ? { present: true, value: current } : { present: false }
}

function safeOrigin(metadata: unknown): SafeOrigin | undefined {
  const source = record(record(metadata)?.name)
  const type = source?.type
  if (typeof type !== 'string') return undefined
  switch (type) {
    case 'mdm':
      return { sourceLabel: 'Managed device policy', sourceScope: 'system-policy' }
    case 'system':
      return { sourceLabel: 'System defaults', sourceScope: 'system-default' }
    case 'enterpriseManaged':
      return { sourceLabel: 'Enterprise managed policy', sourceScope: 'system-policy' }
    case 'user':
      return source?.profile === null || source?.profile === undefined
        ? { sourceLabel: 'All projects', sourceScope: 'user' }
        : { sourceLabel: 'Codex profile', sourceScope: 'profile' }
    case 'project':
      return { sourceLabel: 'Project', sourceScope: 'project' }
    case 'sessionFlags':
      return { sourceLabel: 'Session flags', sourceScope: 'session' }
    case 'legacyManagedConfigTomlFromFile':
    case 'legacyManagedConfigTomlFromMdm':
      return { sourceLabel: 'Managed policy', sourceScope: 'system-policy' }
    default:
      return undefined
  }
}

function safeOrigins(raw: JsonRecord): Map<string, SafeOrigin> {
  const out = new Map<string, SafeOrigin>()
  for (const [path, metadata] of Object.entries(raw)) {
    if (path.length > 512 || !originPathShape.test(path)) continue
    const origin = safeOrigin(metadata)
    if (origin) out.set(path, origin)
  }
  return out
}

function originFor(origins: Map<string, SafeOrigin>, path: readonly string[]): SafeOrigin | undefined {
  for (let length = path.length; length > 0; length -= 1) {
    const found = origins.get(path.slice(0, length).join('.'))
    if (found) return found
  }
  return undefined
}

function addRequirementPaths(requirements: JsonRecord | null): Set<string> {
  const paths = new Set<string>()
  if (!requirements) return paths
  const addIfPresent = (key: string, ...settingPaths: string[]): void => {
    if (requirements[key] !== null && requirements[key] !== undefined) {
      for (const path of settingPaths) paths.add(path)
    }
  }
  addIfPresent('allowedApprovalPolicies', 'approval_policy')
  addIfPresent('allowedApprovalsReviewers', 'approvals_reviewer')
  addIfPresent('allowedSandboxModes', 'sandbox_mode')
  addIfPresent('allowedWindowsSandboxImplementations', 'windows.sandbox')
  addIfPresent('allowedPermissionProfiles', 'permission_profile', 'default_permissions')
  addIfPresent('defaultPermissions', 'permission_profile', 'default_permissions')
  addIfPresent('allowedWebSearchModes', 'web_search', 'tools.web_search')
  addIfPresent('allowManagedHooksOnly', 'hooks')
  addIfPresent('hooks', 'hooks')
  addIfPresent('allowAppshots', 'features.appshots')
  addIfPresent('allowRemoteControl', 'features.remote_control')
  addIfPresent('computerUse', 'features.computer_use', 'computer_use')
  addIfPresent('enforceResidency', 'enforce_residency')
  addIfPresent('network', 'experimental_network', 'network')

  const features = record(requirements.featureRequirements)
  if (features) for (const name of Object.keys(features)) paths.add(`features.${name}`)
  return paths
}

function isConstrained(paths: Set<string>, path: readonly string[]): boolean {
  const dotted = path.join('.')
  for (const constrained of paths) {
    if (dotted === constrained || dotted.startsWith(`${constrained}.`) || constrained.startsWith(`${dotted}.`)) return true
  }
  return false
}

function mapCodexAppServerObservation(
  raw: RawAppServerObservation,
  settings: readonly AgentConfigSetting[]
): CodexConfigObservation {
  const origins = safeOrigins(raw.origins)
  const constrainedPaths = addRequirementPaths(raw.requirements)
  const observations: Record<string, CodexConfigSettingObservation> = Object.create(null) as Record<string, CodexConfigSettingObservation>
  for (const setting of settings) {
    const read = valueAt(raw.config, setting.path)
    const origin = originFor(origins, setting.path)
    const redacted = read.present && (setting.sensitive || agentConfigValueContainsSecretKey(read.value))
    const effective: AgentConfigObservedValue = redacted
      ? { present: true, known: true, redacted: true, ...(origin ?? { sourceLabel: 'Codex effective configuration' }) }
      : {
          present: read.present,
          known: true,
          ...(read.present ? { value: read.value } : {}),
          ...(origin ?? (read.present ? { sourceLabel: 'Codex effective configuration' } : {}))
        }
    observations[setting.id] = { effective, constrained: isConstrained(constrainedPaths, setting.path) }
  }
  return { settings: observations }
}

function parseResponseResult(value: unknown): JsonRecord {
  const response = record(value)
  if (!response || response.error !== undefined) throw new Error('Codex app-server rejected a configuration request.')
  const result = record(response.result)
  if (!result) throw new Error('Codex app-server returned an invalid configuration response.')
  return result
}

async function runAppServer(
  bin: string,
  request: CodexConfigObservationRequest,
  clientVersion: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<RawAppServerObservation> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(bin, ['app-server'], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      reject(new Error('Codex app-server could not be started.'))
      return
    }

    let settled = false
    let outputBytes = 0
    let stdout = Buffer.alloc(0)
    let configResponse: JsonRecord | undefined
    let requirementsResponse: JsonRecord | undefined

    const stop = (): void => {
      child.stdin.end()
      if (!child.killed) child.kill()
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      reject(new Error(message))
    }
    const complete = (): void => {
      if (settled || !configResponse || !requirementsResponse) return
      try {
        const configResult = parseResponseResult(configResponse)
        const requirementsResult = parseResponseResult(requirementsResponse)
        const config = record(configResult.config)
        const origins = record(configResult.origins)
        const requirementsValue = requirementsResult.requirements
        const requirements = requirementsValue === null ? null : record(requirementsValue)
        if (!config || !origins || (requirementsValue !== null && !requirements)) {
          fail('Codex app-server returned an invalid configuration response.')
          return
        }
        settled = true
        clearTimeout(timer)
        stop()
        resolve({ config, origins, requirements })
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Codex app-server returned an invalid configuration response.')
      }
    }
    const send = (message: JsonRecord): void => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    const handleLine = (line: Buffer): void => {
      if (!line.length) return
      if (line.length > MAX_LINE_BYTES) {
        fail('Codex app-server exceeded the response limit.')
        return
      }
      let message: JsonRecord | null = null
      try {
        message = record(JSON.parse(line.toString('utf8')))
      } catch {
        fail('Codex app-server returned malformed JSONL.')
        return
      }
      if (!message) return
      if (message.id === 1) {
        try {
          parseResponseResult(message)
        } catch (error) {
          fail(error instanceof Error ? error.message : 'Codex app-server initialization failed.')
          return
        }
        send({ method: 'initialized', params: {} })
        send({ method: 'config/read', id: 2, params: { includeLayers: true, ...(request.cwd ? { cwd: request.cwd } : {}) } })
        send({ method: 'configRequirements/read', id: 3, params: {} })
      } else if (message.id === 2) {
        configResponse = message
        complete()
      } else if (message.id === 3) {
        requirementsResponse = message
        complete()
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        fail('Codex app-server exceeded the response limit.')
        return
      }
      stdout = Buffer.concat([stdout, chunk])
      let newline = stdout.indexOf(0x0a)
      while (newline >= 0 && !settled) {
        const line = stdout.subarray(0, newline)
        stdout = stdout.subarray(newline + 1)
        handleLine(line)
        newline = stdout.indexOf(0x0a)
      }
      if (stdout.length > MAX_LINE_BYTES) fail('Codex app-server exceeded the response limit.')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) fail('Codex app-server exceeded the response limit.')
    })
    child.stdin.on('error', () => fail('Codex app-server closed before configuration was resolved.'))
    child.stdout.on('error', () => fail('Codex app-server closed before configuration was resolved.'))
    child.stderr.on('error', () => fail('Codex app-server closed before configuration was resolved.'))
    child.on('error', () => fail('Codex app-server could not be started.'))
    child.on('close', () => {
      if (!settled) fail('Codex app-server closed before configuration was resolved.')
    })

    const timer = setTimeout(() => fail('Codex app-server configuration resolution timed out.'), timeoutMs)
    timer.unref?.()
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'mogginglabs_workspace',
          title: 'MoggingLabs Workspace',
          version: clientVersion
        },
        capabilities: {
          optOutNotificationMethods: []
        }
      }
    })
  })
}

export class CodexAppServerConfigResolver implements CodexConfigResolverPort {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly options: CodexAppServerResolverOptions = {}) {}

  async observe(request: CodexConfigObservationRequest): Promise<CodexConfigObservation> {
    const cacheKey = createHash('sha256')
      .update(request.cwd ?? '')
      .update('\u0000')
      .update(request.env?.CODEX_HOME ?? '')
      .digest('hex')
    const now = Date.now()
    let cached = this.cache.get(cacheKey)
    if (!cached || cached.expiresAt <= now) {
      const value = runAppServer(
        this.options.bin ?? 'codex',
        request,
        this.options.clientVersion ?? '0.0.0',
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      )
      cached = { expiresAt: now + (this.options.cacheMs ?? DEFAULT_CACHE_MS), value }
      this.cache.set(cacheKey, cached)
      void value.catch(() => {
        if (this.cache.get(cacheKey)?.value === value) this.cache.delete(cacheKey)
      })
    }
    return mapCodexAppServerObservation(await cached.value, request.settings)
  }

  invalidate(): void {
    this.cache.clear()
  }
}
