import type { AgentConfigCatalog, AgentConfigProviderId, AgentConfigSurface } from '@contracts'

export function compileJsonSchemaCatalog(input: {
  provider: Exclude<AgentConfigProviderId, 'aider'>
  surface?: AgentConfigSurface
  schema: unknown
  sourceUrl: string
  checkedAt?: number
  installedVersion?: string
}): AgentConfigCatalog
export function compileAiderSampleCatalog(input: {
  sample: string
  sourceUrl: string
  help: string
  helpSourceUrl: string
  checkedAt?: number
  helpCheckedAt?: number
  installedVersion?: string
}): AgentConfigCatalog
export function combineCatalogs(catalogs: AgentConfigCatalog[]): AgentConfigCatalog
export function validateCatalog(catalog: unknown): AgentConfigCatalog
export function validateCatalogBundle(bundle: unknown): { generatedAt: number; revision: string; providers: Record<AgentConfigProviderId, AgentConfigCatalog> }
export const CATALOG_PROVIDER_NAMES: Readonly<Record<AgentConfigProviderId, string>>
