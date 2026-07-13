import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  combineCatalogs,
  compileAiderSampleCatalog,
  compileJsonSchemaCatalog,
  validateCatalogBundle
} from '../src/backend/features/agent-settings/catalog/compiler.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputFile = resolve(root, 'src/backend/features/agent-settings/catalog/bundled.json')
const maxBytes = 4 * 1024 * 1024
const timeoutMs = 20_000

// Keep this list inert and explicit. Redirect destinations are checked too, so a
// compromised upstream cannot turn the updater into an arbitrary network client.
const sources = Object.freeze({
  claude: [{
    surface: 'runtime',
    kind: 'json-schema',
    url: 'https://json.schemastore.org/claude-code-settings.json',
    hosts: ['json.schemastore.org', 'www.schemastore.org', 'raw.githubusercontent.com']
  }],
  codex: [{
    surface: 'runtime',
    kind: 'json-schema',
    url: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json',
    hosts: ['raw.githubusercontent.com']
  }],
  gemini: [{
    surface: 'runtime',
    kind: 'json-schema',
    url: 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json',
    hosts: ['raw.githubusercontent.com']
  }],
  aider: [{
    surface: 'runtime',
    kind: 'aider-sample',
    url: 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/sample.aider.conf.yml',
    hosts: ['raw.githubusercontent.com']
  }, {
    surface: 'runtime',
    kind: 'aider-help',
    url: 'https://aider.chat/docs/config/options.html',
    hosts: ['aider.chat']
  }],
  opencode: [
    {
      surface: 'runtime',
      kind: 'json-schema',
      url: 'https://opencode.ai/config.json',
      hosts: ['opencode.ai']
    },
    {
      surface: 'tui',
      kind: 'json-schema',
      url: 'https://opencode.ai/tui.json',
      hosts: ['opencode.ai']
    }
  ]
})

function assertAllowed(url, source) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !source.hosts.includes(parsed.hostname)) {
    throw new Error(`Catalog redirect is not allowlisted: ${parsed.origin}`)
  }
}

async function download(source) {
  assertAllowed(source.url, source)
  const response = await fetch(source.url, {
    headers: { accept: source.kind === 'json-schema' ? 'application/schema+json, application/json' : 'text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  })
  assertAllowed(response.url, source)
  if (!response.ok) throw new Error(`${source.url} returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new Error(`${source.url} exceeds the ${maxBytes} byte limit`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error(`${source.url} exceeds the ${maxBytes} byte limit`)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

async function compile(provider, source, checkedAt) {
  const text = await download(source)
  let schema
  try {
    schema = JSON.parse(text)
  } catch {
    throw new Error(`${provider}/${source.surface} did not return valid JSON`)
  }
  return compileJsonSchemaCatalog({ provider, surface: source.surface, schema, sourceUrl: source.url, checkedAt })
}

async function main() {
  const checkedAt = Date.now()
  const providers = {}
  for (const [provider, providerSources] of Object.entries(sources)) {
    if (provider === 'aider') {
      const sampleSource = providerSources.find((source) => source.kind === 'aider-sample')
      const helpSource = providerSources.find((source) => source.kind === 'aider-help')
      if (!sampleSource || !helpSource) throw new Error('Aider catalog requires its official sample and option reference')
      const [sample, help] = await Promise.all([download(sampleSource), download(helpSource)])
      providers[provider] = compileAiderSampleCatalog({
        sample,
        sourceUrl: sampleSource.url,
        help,
        helpSourceUrl: helpSource.url,
        checkedAt,
        helpCheckedAt: checkedAt
      })
      continue
    }
    const catalogs = await Promise.all(providerSources.map((source) => compile(provider, source, checkedAt)))
    providers[provider] = catalogs.length === 1 ? catalogs[0] : combineCatalogs(catalogs)
  }
  const revision = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(providers).map(([id, catalog]) => [id, catalog.catalogVersion]))))
    .digest('hex')
  const bundle = validateCatalogBundle({ generatedAt: checkedAt, revision, providers })
  const serialized = JSON.stringify(bundle, null, 2) + '\n'
  await mkdir(dirname(outputFile), { recursive: true })
  const temporary = `${outputFile}.${process.pid}.tmp`
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, outputFile)
  } finally {
    await rm(temporary, { force: true })
  }
  for (const [provider, catalog] of Object.entries(providers)) {
    process.stdout.write(`${provider}: ${catalog.settings.length} settings\n`)
  }
  process.stdout.write(`revision: ${revision}\n`)
}

await main()
