import { AGENT_CLI_IDS, isAgentCliId, type AgentCliId, type AgentExecutionTarget } from './agent-cli'

/** Settings keeps a compatibility alias while every feature converges on AgentCliId. */
export const AGENT_CONFIG_PROVIDER_IDS = AGENT_CLI_IDS
export type AgentConfigProviderId = AgentCliId

/** Provider files are not uniformly scoped. These names describe real layers, not UI aliases. */
export type AgentConfigScope =
  | 'session'
  | 'project'
  | 'local'
  | 'profile'
  | 'user'
  | 'system-default'
  | 'system-policy'

/** OpenCode has a second schema/file for TUI settings; other providers use `runtime`. */
export type AgentConfigSurface = 'runtime' | 'tui'

export type AgentConfigOwnership = 'once' | 'enforce'
export type AgentConfigIntentOperation = 'set' | 'unset'
export type AgentConfigReleaseBehavior = 'keep' | 'restore'
export type AgentConfigStability = 'stable' | 'experimental' | 'deprecated' | 'internal'
export type AgentConfigActivation = 'live' | 'restart' | 'next-session' | 'unknown'
export type AgentConfigSyncState =
  | 'observed'
  | 'pending'
  | 'synced'
  | 'drifted'
  | 'shadowed'
  | 'parse-error'
  | 'unsupported'
  | 'pending-restart'
  | 'blocked'
  | 'error'

/** JSON-compatible by design: this is safe to persist and transport over Electron IPC. */
export type AgentConfigValue =
  | null
  | boolean
  | number
  | string
  | AgentConfigValue[]
  | { [key: string]: AgentConfigValue }

export type AgentConfigValueKind =
  | 'boolean'
  | 'string'
  | 'number'
  | 'integer'
  | 'enum'
  | 'array'
  | 'object'
  | 'map'
  | 'any'
  | 'union'

/** A deliberately small, renderer-safe subset of JSON Schema. */
export interface AgentConfigValueSchema {
  kind: AgentConfigValueKind
  nullable?: boolean
  enum?: AgentConfigValue[]
  enumLabels?: string[]
  minimum?: number
  maximum?: number
  pattern?: string
  format?: 'path' | 'uri' | 'duration' | 'color' | 'command' | 'multiline' | 'unknown'
  item?: AgentConfigValueSchema
  properties?: Record<string, AgentConfigValueSchema>
  required?: string[]
  additional?: AgentConfigValueSchema | boolean
  alternatives?: AgentConfigValueSchema[]
  unionMode?: 'anyOf' | 'oneOf'
}

/** A concrete layer target. `targetId` is `default`, a workspace id, or a profile id. */
export interface AgentConfigTarget {
  scope: AgentConfigScope
  targetId: string
  execution: AgentExecutionTarget
}

export interface AgentConfigScopeOption {
  target: AgentConfigTarget
  label: string
  description: string
  writable: boolean
  reason?: string
  selectedByDefault?: boolean
}

export interface AgentConfigSetting {
  /** Stable within one provider catalog. Mutations name this id, never an arbitrary file path. */
  id: string
  provider: AgentConfigProviderId
  surface: AgentConfigSurface
  path: string[]
  title: string
  description: string
  category: string
  schema: AgentConfigValueSchema
  defaultValue?: AgentConfigValue
  scopes: AgentConfigScope[]
  activation: AgentConfigActivation
  stability: AgentConfigStability
  sensitive: boolean
  writable: boolean
  writeReason?: string
  editor?: 'control' | 'dedicated' | 'read-only'
  sourceUrl: string
  aliases?: string[]
  minVersion?: string
  maxVersion?: string
  /** Another Workspace feature owns this launch-effective key. */
  workspaceOwner?: 'context' | 'notifications' | 'integrations' | 'authentication'
  /** High-risk choices receive an explicit confirmation in the UI. */
  danger?: 'permission-bypass' | 'network' | 'telemetry' | 'destructive'
  /** Aider's exact option metadata; absent for schema-driven providers. */
  environmentVariable?: string
  cliFlag?: string
}

export interface AgentConfigCatalogSource {
  url: string
  checkedAt: number
  etag?: string
  version?: string
  exactVersion: boolean
}

export interface AgentConfigCatalog {
  provider: AgentConfigProviderId
  providerName: string
  catalogVersion: string
  generatedAt: number
  installedVersion?: string
  stale: boolean
  sources: AgentConfigCatalogSource[]
  categories: string[]
  settings: AgentConfigSetting[]
}

export interface AgentConfigObservedValue {
  present: boolean
  /** Omitted for sensitive fields and sources that cannot be inspected safely. */
  value?: AgentConfigValue
  redacted?: boolean
  sourceLabel?: string
  sourceScope?: AgentConfigScope
  known: boolean
}

export interface AgentConfigDesiredValue {
  operation: AgentConfigIntentOperation
  value?: AgentConfigValue
  ownership: AgentConfigOwnership
  updatedAt: number
}

export interface AgentConfigSettingState {
  setting: AgentConfigSetting
  selected: AgentConfigObservedValue
  effective: AgentConfigObservedValue
  desired?: AgentConfigDesiredValue
  sync: AgentConfigSyncState
  message?: string
  constrained?: boolean
  activationPending?: boolean
}

export interface AgentConfigProviderSummary {
  provider: AgentConfigProviderId
  name: string
  installed: boolean
  version?: string
  catalogVersion: string
  catalogCheckedAt?: number
  catalogStale: boolean
  enforcedCount: number
  sync: AgentConfigSyncState
  message?: string
}

export interface AgentConfigSnapshot {
  provider: AgentConfigProviderId
  providerName: string
  installed: boolean
  installedVersion?: string
  target: AgentConfigTarget
  scopes: AgentConfigScopeOption[]
  catalogVersion: string
  catalogGeneratedAt: number
  catalogStale: boolean
  settings: AgentConfigSettingState[]
  sync: AgentConfigSyncState
  message?: string
}

/** Persisted desired-state row. File paths never cross IPC, but the trusted path does persist. */
export interface AgentConfigOverrideRecord {
  provider: AgentConfigProviderId
  scope: AgentConfigScope
  targetId: string
  surface: AgentConfigSurface
  settingId: string
  path: string[]
  operation: AgentConfigIntentOperation
  desiredValue?: AgentConfigValue
  ownership: AgentConfigOwnership
  baselinePresent: boolean
  baselineValue?: AgentConfigValue
  catalogVersion: string
  lastAppliedValue?: AgentConfigValue
  lastAppliedHash?: string
  status: AgentConfigSyncState
  lastError?: string
  createdAt: number
  updatedAt: number
  appliedAt?: number
}

export function isAgentConfigProviderId(value: unknown): value is AgentConfigProviderId {
  return isAgentCliId(value)
}
