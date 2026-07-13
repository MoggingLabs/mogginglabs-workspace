import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateCatalogBundle } from '../src/backend/features/agent-settings/catalog/compiler.mjs'

const file = resolve('src/backend/features/agent-settings/catalog/bundled.json')
const bundle = validateCatalogBundle(JSON.parse(await readFile(file, 'utf8')))
const registrySource = await readFile('src/backend/core/agent-clis/registry.ts', 'utf8')
const updaterSource = await readFile('scripts/update-agent-settings-catalog.mjs', 'utf8')
const urls = (text) => new Set([...text.matchAll(/url:\s*['"](https:\/\/[^'"]+)['"]/g)].map((match) => match[1]))
const registryUrls = urls(registrySource)
const updaterUrls = urls(updaterSource)
for (const url of updaterUrls) if (!registryUrls.has(url)) throw new Error(`Updater source is absent from the canonical registry: ${url}`)
const minimums = Object.freeze({ claude: 200, codex: 100, gemini: 100, aider: 100, opencode: 100 })
const canonicalCategories = new Set([
  'Authentication & accounts', 'Permissions & approvals', 'Models & reasoning',
  'Tools & integrations', 'Agents & automation', 'Context & memory',
  'Notifications & hooks', 'Execution & sandbox', 'Network & web',
  'Interface & terminal', 'Projects & files', 'Telemetry & updates',
  'Advanced & experimental', 'General'
])

for (const [provider, minimum] of Object.entries(minimums)) {
  const catalog = bundle.providers[provider]
  if (catalog.settings.length < minimum) {
    throw new Error(`${provider} catalog has ${catalog.settings.length} settings; expected at least ${minimum}`)
  }
  if (catalog.settings.some((setting) => setting.sensitive && setting.writable)) {
    throw new Error(`${provider} catalog exposes a sensitive setting as writable`)
  }
  if (catalog.settings.some((setting) => setting.path.includes('*') && setting.writable)) {
    throw new Error(`${provider} catalog exposes a dynamic template as directly writable`)
  }
  if (catalog.settings.some((setting) => setting.workspaceOwner && setting.writable)) {
    throw new Error(`${provider} catalog exposes a Workspace-owned launch key as writable`)
  }
  if (catalog.categories.length > 32) throw new Error(`${provider} catalog taxonomy is overloaded (${catalog.categories.length} categories)`)
  if (catalog.categories.some((category) => !canonicalCategories.has(category))) throw new Error(`${provider} catalog contains a non-canonical category`)
  for (const source of catalog.sources) {
    if (!updaterUrls.has(source.url)) throw new Error(`${provider} bundle source is absent from the allowlisted updater: ${source.url}`)
  }
  const ids = new Set(catalog.settings.map((setting) => setting.id))
  if (ids.size !== catalog.settings.length) throw new Error(`${provider} catalog contains duplicate ids`)
  process.stdout.write(`${provider}: ${catalog.settings.length} validated settings\n`)
}

const rows = new Map(Object.values(bundle.providers).flatMap((catalog) => catalog.settings).map((setting) => [setting.id, setting]))
const requireRow = (id) => {
  const row = rows.get(id)
  if (!row) throw new Error(`Required semantic fixture is absent: ${id}`)
  return row
}
for (const id of [
  'claude:runtime:/env/ANTHROPIC_CUSTOM_HEADERS',
  'claude:runtime:/env/OTEL_EXPORTER_OTLP_HEADERS',
  'claude:runtime:/env/CLAUDE_CODE_CLIENT_KEY',
  'claude:runtime:/env/CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'claude:runtime:/env/GOOGLE_APPLICATION_CREDENTIALS'
]) {
  const row = requireRow(id)
  if (!row.sensitive || row.writable) throw new Error(`Secret semantic fixture is exposed: ${id}`)
}
for (const id of [
  'codex:runtime:/model_auto_compact_token_limit',
  'codex:runtime:/model_auto_compact_token_limit_scope',
  'codex:runtime:/features/token_budget',
  'codex:runtime:/tool_output_token_limit',
  'codex:runtime:/features/secret_auth_storage',
  'claude:runtime:/env/CLAUDE_CODE_API_KEY_HELPER_TTL_MS'
]) {
  if (requireRow(id).sensitive) throw new Error(`Benign token/storage fixture is over-redacted: ${id}`)
}
for (const id of [
  'claude:runtime:/otelHeadersHelper',
  'gemini:runtime:/tools/callCommand',
  'gemini:runtime:/tools/discoveryCommand',
  'aider:runtime:/test-cmd',
  'aider:runtime:/lint-cmd'
]) {
  const row = requireRow(id)
  if (row.writable || row.editor !== 'dedicated') throw new Error(`Executable fixture lacks a dedicated editor: ${id}`)
}
for (const id of [
  'codex:runtime:/approval_policy',
  'codex:runtime:/sandbox_mode',
  'gemini:runtime:/general/defaultApprovalMode',
  'gemini:runtime:/tools/allowed',
  'gemini:runtime:/tools/sandboxNetworkAccess',
  'claude:runtime:/sandbox/allowUnsandboxedCommands'
]) {
  if (!requireRow(id).danger) throw new Error(`High-risk fixture lacks danger metadata: ${id}`)
}
for (const catalog of Object.values(bundle.providers)) {
  for (const row of catalog.settings) {
    if (/Requires restart:\s*no/i.test(row.description) && row.activation !== 'live') throw new Error(`Restart:no fixture is not live: ${row.id}`)
    if ((row.path.includes('*') || row.schema.additional !== undefined && row.schema.additional !== false) && row.writable) {
      throw new Error(`Dynamic aggregate is directly writable: ${row.id}`)
    }
  }
}

for (const id of [
  'aider:runtime:/set-env',
  'aider:runtime:/api-key',
  'aider:runtime:/alias',
  'aider:runtime:/lint-cmd',
  'aider:runtime:/file',
  'aider:runtime:/read'
]) {
  const row = requireRow(id)
  if (row.schema.kind !== 'array' || row.schema.item?.kind !== 'string') throw new Error(`Repeatable Aider fixture is not a string list: ${id}`)
}
for (const [id, kind] of [
  ['aider:runtime:/timeout', 'number'],
  ['aider:runtime:/max-chat-history-tokens', 'integer'],
  ['aider:runtime:/cache-keepalive-pings', 'integer'],
  ['aider:runtime:/map-tokens', 'integer'],
  ['aider:runtime:/map-multiplier-no-files', 'number']
]) {
  if (requireRow(id).schema.kind !== kind) throw new Error(`Numeric Aider fixture has the wrong type: ${id}`)
}
const aiderConfig = requireRow('aider:runtime:/config')
if (aiderConfig.writable || aiderConfig.editor !== 'dedicated' || JSON.stringify(aiderConfig.scopes) !== JSON.stringify(['session']) || aiderConfig.defaultValue !== undefined) {
  throw new Error('Aider config selector is exposed as a durable preference')
}
const aiderSetEnv = requireRow('aider:runtime:/set-env')
if (!aiderSetEnv.sensitive || aiderSetEnv.writable || aiderSetEnv.editor !== 'read-only' || aiderSetEnv.workspaceOwner !== 'authentication') {
  throw new Error('Aider set-env can expose NAME=value secrets through ordinary settings storage')
}
const aiderSources = new Set(bundle.providers.aider.sources.map((source) => source.url))
for (const url of [
  'https://aider.chat/docs/config/options.html',
  'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/sample.aider.conf.yml'
]) {
  if (!aiderSources.has(url)) throw new Error(`Aider bundle omitted an official compiler input: ${url}`)
}

const expectedRevision = (await import('node:crypto')).createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(bundle.providers).map(([id, catalog]) => [id, catalog.catalogVersion]))))
  .digest('hex')
if (bundle.revision !== expectedRevision) throw new Error('Catalog bundle revision does not match its provider catalogs')
