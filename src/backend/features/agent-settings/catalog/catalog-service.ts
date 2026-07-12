import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { AgentConfigCatalog, AgentConfigProviderId } from '@contracts'
import { AGENT_CLI_REGISTRY, findAgentCliDefinition } from '../../../core/agent-clis'
import bundledJson from './bundled.json'
import {
  combineCatalogs,
  compileAiderSampleCatalog,
  compileJsonSchemaCatalog,
  validateCatalogBundle
} from './compiler.mjs'

interface CatalogBundle {
  generatedAt: number
  revision: string
  providers: Record<AgentConfigProviderId, AgentConfigCatalog>
}

interface DownloadedSource {
  text: string
  checkedAt: number
  etag?: string
}

export interface AgentSettingsCatalogServiceOptions {
  cacheFile: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  refreshIntervalMs?: number
  timeoutMs?: number
}

const bundled = validateCatalogBundle(bundledJson as unknown) as CatalogBundle
const day = 24 * 60 * 60 * 1_000
const maxSourceBytes = 4 * 1024 * 1024
const maxCacheBytes = 8 * 1024 * 1024
const redirectHosts = new Set([
  'aider.chat',
  'json.schemastore.org',
  'www.schemastore.org',
  'raw.githubusercontent.com',
  'opencode.ai'
])

function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && redirectHosts.has(url.hostname)
  } catch {
    return false
  }
}

function sourceAge(catalog: AgentConfigCatalog, now: number): number {
  const checkedAt = catalog.sources.reduce((oldest, source) => Math.min(oldest, source.checkedAt), Number.POSITIVE_INFINITY)
  return Number.isFinite(checkedAt) && checkedAt > 0 ? Math.max(0, now - checkedAt) : Number.POSITIVE_INFINITY
}

/**
 * Validated, last-known-good catalog repository. Bundled data is always the
 * floor; refresh failures only mark it stale and never replace it with
 * unvalidated upstream bytes.
 */
export class AgentSettingsCatalogService {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  private readonly refreshIntervalMs: number
  private readonly timeoutMs: number
  private catalogs = new Map<AgentConfigProviderId, AgentConfigCatalog>(
    Object.entries(bundled.providers) as [AgentConfigProviderId, AgentConfigCatalog][]
  )
  private initialized = false
  private persistQueue: Promise<void> = Promise.resolve()
  private readonly inFlight = new Map<AgentConfigProviderId, Promise<AgentConfigCatalog | null>>()

  constructor(private readonly options: AgentSettingsCatalogServiceOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.refreshIntervalMs = options.refreshIntervalMs ?? day
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  async initialize(
    installedVersions: Partial<Record<AgentConfigProviderId, string>> = {},
    refresh = true
  ): Promise<void> {
    if (!this.initialized) {
      await this.loadCache()
      this.initialized = true
    }
    if (refresh) await this.refreshDue(installedVersions)
  }

  get(provider: AgentConfigProviderId, installedVersion?: string): AgentConfigCatalog | null {
    const catalog = this.catalogs.get(provider)
    if (!catalog) return null
    const stale = catalog.stale || this.isDue(catalog, installedVersion)
    return {
      ...catalog,
      ...(installedVersion ? { installedVersion } : {}),
      stale
    }
  }

  async refreshDue(installedVersions: Partial<Record<AgentConfigProviderId, string>> = {}): Promise<void> {
    await Promise.allSettled(AGENT_CLI_REGISTRY.map(async ({ id }) => {
      const current = this.catalogs.get(id)
      const version = installedVersions[id]
      if (!current || this.isDue(current, version)) await this.refresh(id, version)
    }))
  }

  refresh(provider: AgentConfigProviderId, installedVersion?: string): Promise<AgentConfigCatalog | null> {
    const running = this.inFlight.get(provider)
    if (running) return running
    const request = this.refreshProvider(provider, installedVersion).finally(() => this.inFlight.delete(provider))
    this.inFlight.set(provider, request)
    return request
  }

  private isDue(catalog: AgentConfigCatalog, installedVersion?: string): boolean {
    return catalog.stale || sourceAge(catalog, this.now()) >= this.refreshIntervalMs ||
      (!!installedVersion && catalog.installedVersion !== installedVersion)
  }

  private async refreshProvider(provider: AgentConfigProviderId, installedVersion?: string): Promise<AgentConfigCatalog | null> {
    const definition = findAgentCliDefinition(provider)
    if (!definition) return null
    try {
      if (provider === 'aider') {
        const sampleSource = definition.config.catalogSources.find((source) => source.kind === 'aider-sample')
        const helpSource = definition.config.catalogSources.find((source) => source.kind === 'aider-help')
        if (!sampleSource || !helpSource) throw new Error('Aider catalog requires its official sample and option reference')
        const [sample, help] = await Promise.all([
          this.download(sampleSource.url),
          this.download(helpSource.url)
        ])
        let next = compileAiderSampleCatalog({
          sample: sample.text,
          sourceUrl: sampleSource.url,
          checkedAt: sample.checkedAt,
          help: help.text,
          helpSourceUrl: helpSource.url,
          helpCheckedAt: help.checkedAt
        })
        const etags = new Map([
          [sampleSource.url, sample.etag],
          [helpSource.url, help.etag]
        ])
        next = {
          ...next,
          ...(installedVersion ? { installedVersion } : {}),
          sources: next.sources.map((entry) => ({
            ...entry,
            ...(etags.get(entry.url) ? { etag: etags.get(entry.url) } : {}),
            ...(installedVersion ? { version: installedVersion } : {}),
            // Both sources track upstream main/current docs, not the installed wheel.
            exactVersion: false
          }))
        }
        await this.commit(provider, next)
        return this.get(provider, installedVersion)
      }
      const compiled: AgentConfigCatalog[] = []
      for (const source of definition.config.catalogSources) {
        const downloaded = await this.download(source.url)
        if (source.kind !== 'json-schema') throw new Error(`Unsupported catalog source kind ${source.kind}`)
        const schema = JSON.parse(downloaded.text) as unknown
        let catalog: AgentConfigCatalog = compileJsonSchemaCatalog({
          provider: provider as Exclude<AgentConfigProviderId, 'aider'>,
          surface: definition.config.surfaces.find((surface) => source.id.includes(surface.id))?.id ??
            (source.id.includes('tui') ? 'tui' : 'runtime'),
          schema,
          sourceUrl: source.url,
          checkedAt: downloaded.checkedAt
        })
        catalog = {
          ...catalog,
          ...(installedVersion ? { installedVersion } : {}),
          sources: catalog.sources.map((entry) => ({
            ...entry,
            ...(downloaded.etag ? { etag: downloaded.etag } : {}),
            ...(installedVersion ? { version: installedVersion } : {}),
            exactVersion: false
          }))
        }
        compiled.push(catalog)
      }
      if (!compiled.length) throw new Error(`No catalog source is configured for ${provider}`)
      const next = compiled.length === 1 ? compiled[0] : combineCatalogs(compiled)
      await this.commit(provider, next)
      return this.get(provider, installedVersion)
    } catch {
      const current = this.catalogs.get(provider)
      if (current) this.catalogs.set(provider, { ...current, stale: true })
      return this.get(provider, installedVersion)
    }
  }

  private async download(sourceUrl: string): Promise<DownloadedSource> {
    if (!allowedUrl(sourceUrl)) throw new Error('Catalog source is not allowlisted')
    const response = await this.fetchImpl(sourceUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/schema+json, application/json, text/plain' }
    })
    if (!allowedUrl(response.url)) throw new Error('Catalog redirect is not allowlisted')
    if (!response.ok) throw new Error(`Catalog source returned HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxSourceBytes) throw new Error('Catalog source is too large')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxSourceBytes) throw new Error('Catalog source is too large')
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      checkedAt: this.now(),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {})
    }
  }

  private async loadCache(): Promise<void> {
    try {
      const info = await stat(this.options.cacheFile)
      if (!info.isFile() || info.size > maxCacheBytes) return
      const raw = await readFile(this.options.cacheFile)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
      const cached = validateCatalogBundle(JSON.parse(text)) as CatalogBundle
      const futureLimit = this.now() + 5 * 60 * 1_000
      if (cached.generatedAt > futureLimit || Object.values(cached.providers).some((catalog) =>
        catalog.generatedAt > futureLimit || catalog.sources.some((source) => source.checkedAt > futureLimit))) return
      for (const { id } of AGENT_CLI_REGISTRY) {
        const candidate = cached.providers[id]
        const current = this.catalogs.get(id)
        if (candidate && (!current || candidate.generatedAt >= current.generatedAt)) this.catalogs.set(id, candidate)
      }
    } catch {
      // A corrupt cache is disposable; the validated bundled floor remains active.
    }
  }

  private commit(provider: AgentConfigProviderId, catalog: AgentConfigCatalog): Promise<void> {
    const operation = this.persistQueue.catch(() => undefined).then(async () => {
      const next = new Map(this.catalogs)
      next.set(provider, catalog)
      const providers = Object.fromEntries(AGENT_CLI_REGISTRY.map(({ id }) => [id, next.get(id)]))
      const revision = createHash('sha256')
        .update(JSON.stringify(Object.fromEntries(Object.entries(providers).map(([id, catalog]) => [id, catalog?.catalogVersion]))))
        .digest('hex')
      const bundle: CatalogBundle = {
        generatedAt: Math.max(...Object.values(providers).map((catalog) => catalog?.generatedAt ?? 0)),
        revision,
        providers: providers as Record<AgentConfigProviderId, AgentConfigCatalog>
      }
      validateCatalogBundle(bundle)
      await mkdir(dirname(this.options.cacheFile), { recursive: true })
      await writeFileAtomic(this.options.cacheFile, JSON.stringify(bundle), { encoding: 'utf8' })
      this.catalogs = next
    })
    this.persistQueue = operation.catch(() => undefined)
    return operation
  }
}
