import type {
  AgentConfigCatalog,
  AgentConfigIntentOperation,
  AgentConfigOwnership,
  AgentConfigProviderId,
  AgentConfigProviderSummary,
  AgentConfigReleaseBehavior,
  AgentConfigSnapshot,
  AgentConfigSurface,
  AgentConfigTarget,
  AgentConfigTier,
  AgentConfigValue
} from '../domain/agent-settings'

export interface AgentConfigCatalogRequest {
  provider: AgentConfigProviderId
}

export interface AgentConfigSnapshotRequest {
  provider: AgentConfigProviderId
  target?: AgentConfigTarget
}

export interface AgentConfigSetRequest {
  provider: AgentConfigProviderId
  target: AgentConfigTarget
  settingId: string
  operation: AgentConfigIntentOperation
  value?: AgentConfigValue
  ownership: AgentConfigOwnership
}

export interface AgentConfigReleaseRequest {
  provider: AgentConfigProviderId
  target: AgentConfigTarget
  settingId: string
  behavior: AgentConfigReleaseBehavior
}

export interface AgentConfigRefreshRequest {
  provider?: AgentConfigProviderId
  force?: boolean
}

/** ADR 0022: author a cross-account default or one account's pin. `target` names
 *  "this account" for pins — a profile target pins that profile, a user target
 *  pins the primary; main resolves the profile identity, the renderer never does. */
export interface AgentConfigSetDefaultRequest {
  provider: AgentConfigProviderId
  target: AgentConfigTarget
  settingId: string
  operation: AgentConfigIntentOperation
  value?: AgentConfigValue
  tier: AgentConfigTier
}

export interface AgentConfigClearDefaultRequest {
  provider: AgentConfigProviderId
  target: AgentConfigTarget
  settingId: string
  tier: AgentConfigTier
}

/** A key with no default that ≥2 account homes already agree on — the smart-promote
 *  suggestion. Values are non-secret by construction (secret shapes are excluded
 *  main-side before this ever crosses IPC). */
export interface AgentConfigPromotableEntry {
  settingId: string
  surface: AgentConfigSurface
  value: AgentConfigValue
  homes: number
}

export interface AgentConfigPromotableRequest {
  provider: AgentConfigProviderId
}

export interface AgentConfigMutationResult {
  ok: boolean
  reason?: string
  snapshot?: AgentConfigSnapshot
}

export interface AgentConfigRefreshResult {
  ok: boolean
  refreshed: AgentConfigProviderId[]
  reason?: string
}

export interface AgentConfigChangedEvent {
  provider: AgentConfigProviderId
  target?: AgentConfigTarget
}

/** Compile-time documentation for the generic bridge's request/response surface. */
export interface AgentConfigIpcContract {
  providers: { request: void; response: AgentConfigProviderSummary[] }
  catalog: { request: AgentConfigCatalogRequest; response: AgentConfigCatalog | null }
  snapshot: { request: AgentConfigSnapshotRequest; response: AgentConfigSnapshot | null }
  set: { request: AgentConfigSetRequest; response: AgentConfigMutationResult }
  release: { request: AgentConfigReleaseRequest; response: AgentConfigMutationResult }
  refresh: { request: AgentConfigRefreshRequest; response: AgentConfigRefreshResult }
  setDefault: { request: AgentConfigSetDefaultRequest; response: AgentConfigMutationResult }
  clearDefault: { request: AgentConfigClearDefaultRequest; response: AgentConfigMutationResult }
  promotable: { request: AgentConfigPromotableRequest; response: AgentConfigPromotableEntry[] }
  changed: { event: AgentConfigChangedEvent }
}
