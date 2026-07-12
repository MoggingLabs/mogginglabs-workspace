import type {
  AgentConfigCatalog,
  AgentConfigIntentOperation,
  AgentConfigOwnership,
  AgentConfigProviderId,
  AgentConfigProviderSummary,
  AgentConfigReleaseBehavior,
  AgentConfigSnapshot,
  AgentConfigTarget,
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
  changed: { event: AgentConfigChangedEvent }
}
