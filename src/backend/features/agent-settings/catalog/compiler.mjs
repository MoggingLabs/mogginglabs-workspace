import { createHash } from 'node:crypto'

const PROVIDER_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  aider: 'Aider',
  opencode: 'OpenCode'
}

const DEFAULT_SCOPES = {
  claude: ['session', 'project', 'local', 'profile', 'user', 'system-policy'],
  codex: ['session', 'project', 'profile', 'user', 'system-default', 'system-policy'],
  gemini: ['session', 'project', 'profile', 'user', 'system-default', 'system-policy'],
  aider: ['session', 'project', 'user'],
  opencode: ['session', 'project', 'user', 'system-policy']
}

const CLAUDE_MANAGED_ONLY = new Set([
  'allowAllClaudeAiMcps', 'allowedChannelPlugins', 'allowManagedHooksOnly',
  'allowManagedMcpServersOnly', 'allowManagedPermissionRulesOnly', 'blockedMarketplaces',
  'browserExternalPageTools', 'channelsEnabled', 'claudeMd', 'disableSideloadFlags',
  'forceRemoteSettingsRefresh', 'managedMcpServers', 'parentSettingsBehavior',
  'pluginSuggestionMarketplaces', 'pluginTrustMessage', 'policyHelper',
  'requiredMaximumVersion', 'requiredMinimumVersion', 'sshHostAllowlist',
  'strictKnownMarketplaces', 'strictPluginOnlyCustomization', 'wslInheritsWindowsSettings',
  'sandbox.bwrapPath', 'sandbox.socatPath', 'sandbox.enabledPlatforms',
  'sandbox.filesystem.allowManagedReadPathsOnly', 'sandbox.network.allowManagedDomainsOnly'
])

const CODEX_PROJECT_DENY = [
  'openai_base_url', 'chatgpt_base_url', 'apps_mcp_product_sku', 'model_provider',
  'model_providers', 'notify', 'profile', 'profiles',
  'experimental_realtime_webrtc_call_base_url', 'experimental_realtime_ws_base_url',
  'otel', 'features.respect_system_proxy'
]

const AIDER_ONE_SHOT = new Set([
  'help', 'list-models', 'commit', 'lint', 'test', 'just-check-update',
  'install-main-branch', 'upgrade', 'version', 'message', 'message-file', 'apply',
  'apply-clipboard-edits', 'exit', 'show-repo-map', 'show-prompts', 'shell-completions'
])

const AIDER_DEPRECATED = new Set([
  'openai-api-type', 'openai-api-version', 'openai-api-deployment-id',
  'openai-organization-id', 'opus', 'sonnet', 'haiku', '4', '4o', 'mini',
  '4-turbo', '35turbo', 'deepseek', 'o1-mini', 'o1-preview'
])

// The generated YAML sample deliberately uses human-friendly placeholders, so
// it is not a type schema: current upstream even renders integer/float options
// such as cache-keepalive-pings and map-multiplier-no-files as false/true. These
// types mirror Aider's argparse declarations and are guarded by catalog checks.
const AIDER_NUMERIC_OPTIONS = new Map([
  ['timeout', 'number'],
  ['max-chat-history-tokens', 'integer'],
  ['cache-keepalive-pings', 'integer'],
  ['map-tokens', 'integer'],
  ['map-multiplier-no-files', 'number']
])

const AIDER_REPEATABLE_OPTIONS = new Set([
  'set-env', 'api-key', 'alias', 'lint-cmd', 'file', 'read'
])

const AIDER_META_OPTIONS = new Set(['config'])

const EXECUTABLE_PATH = /(?:^|\.)(hooks?|notify|command|awsCredentialExport|awsAuthRefresh|gcpAuthRefresh|policyHelper)(?:\.|$)/i
const SECRET_SAFE_TERMINALS = new Set([
  'budget', 'limit', 'limits', 'count', 'threshold', 'usage', 'scope', 'scopes',
  'store', 'storage', 'backend', 'provider', 'helper', 'ttl', 'timeout', 'port',
  'url', 'enabled', 'mode', 'type', 'name', 'names', 'files', 'paths', 'envvars',
  'ms', 'millisecond', 'milliseconds', 'second', 'seconds', 'secs'
])
const SECRET_TOKEN_PREFIXES = new Set([
  'access', 'refresh', 'auth', 'authorization', 'bearer', 'oauth', 'identity', 'session'
])
const SECRET_KEY_PREFIXES = new Set(['api', 'private', 'client', 'secret', 'signing', 'encryption'])

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const pointerEscape = (segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')
const idFor = (provider, surface, path) => `${provider}:${surface}:/${path.map(pointerEscape).join('/')}`
const dotted = (path) => path.join('.')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function nameTokens(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function secretShapedName(value) {
  const tokens = nameTokens(value)
  if (!tokens.length || SECRET_SAFE_TERMINALS.has(tokens[tokens.length - 1])) return false
  if (tokens.some((token) => token === 'secret' || token === 'secrets' || token === 'password' || token === 'passphrase' || token === 'authorization' || token === 'cookie' || token === 'cookies')) return true
  if (tokens[tokens.length - 1] === 'credential' || tokens[tokens.length - 1] === 'credentials' || tokens[tokens.length - 1] === 'headers') return true
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === 'api' && (tokens[index + 1] === 'key' || tokens[index + 1] === 'keys')) return true
    if (SECRET_KEY_PREFIXES.has(tokens[index]) && (tokens[index + 1] === 'key' || tokens[index + 1] === 'keys')) return true
    if (SECRET_TOKEN_PREFIXES.has(tokens[index]) && (tokens[index + 1] === 'token' || tokens[index + 1] === 'tokens')) return true
  }
  return tokens.length === 1 && (tokens[0] === 'token' || tokens[0] === 'tokens' || tokens[0] === 'secret' || tokens[0] === 'secrets')
}

function secretCapableSchema(raw, root) {
  const kind = valueSchema(raw, root).kind
  return !['boolean', 'number', 'integer', 'enum'].includes(kind)
}

function executableCallback(path, node, root) {
  const key = dotted(path)
  if (EXECUTABLE_PATH.test(key)) return true
  const tokens = nameTokens(path[path.length - 1] ?? '')
  const terminal = tokens[tokens.length - 1]
  if (!['command', 'cmd', 'helper', 'executable', 'script'].includes(terminal)) return false
  if (path.some((segment) => /^(?:keymap|keybind|shortcuts?)$/i.test(segment))) return false
  const kind = valueSchema(node, root).kind
  return kind === 'string' || kind === 'array' || /(?:shell command|path to an executable|command to (?:run|invoke|execute))/i.test(descriptionOf(node))
}

function humanize(value) {
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (char) => char.toUpperCase())
}

function localRef(root, ref) {
  if (!ref.startsWith('#/')) return undefined
  let current = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(current) || !(key in current)) throw new Error(`Unresolved local schema ref: ${ref}`)
    current = current[key]
  }
  return current
}

function mergeSchema(left, right) {
  if (!isObject(left)) return clone(right) ?? {}
  if (!isObject(right)) return clone(left) ?? {}
  const out = { ...clone(left), ...clone(right) }
  if (left.properties || right.properties) out.properties = { ...(clone(left.properties) ?? {}), ...(clone(right.properties) ?? {}) }
  if (left.required || right.required) out.required = [...new Set([...(left.required ?? []), ...(right.required ?? [])])]
  return out
}

function normalizeNode(raw, root, stack = new Set()) {
  if (!isObject(raw)) return {}
  let node = { ...raw }
  if (typeof node.$ref === 'string') {
    if (node.$ref.startsWith('#/')) {
      if (stack.has(node.$ref)) return { ...node, $ref: undefined }
      const next = new Set(stack)
      next.add(node.$ref)
      const target = normalizeNode(localRef(root, node.$ref), root, next)
      const sibling = { ...node }
      delete sibling.$ref
      node = mergeSchema(target, sibling)
    } else {
      // External model catalogs remain atomic selectors; never fetch recursively.
      const sibling = { ...node }
      delete sibling.$ref
      node = { type: 'string', ...sibling, 'x-external-ref': raw.$ref }
    }
  }
  if (Array.isArray(node.allOf)) {
    let merged = {}
    for (const branch of node.allOf) merged = mergeSchema(merged, normalizeNode(branch, root, stack))
    const sibling = { ...node }
    delete sibling.allOf
    node = mergeSchema(merged, sibling)
  }
  return node
}

function enumValues(node) {
  if (Array.isArray(node.enum)) return clone(node.enum)
  if (node.const !== undefined) return [clone(node.const)]
  const branches = node.oneOf ?? node.anyOf
  if (!Array.isArray(branches)) return undefined
  const values = []
  for (const raw of branches) {
    const branch = raw ?? {}
    if (branch.const !== undefined) values.push(clone(branch.const))
    else if (Array.isArray(branch.enum)) values.push(...clone(branch.enum))
    else return undefined
  }
  return values.length ? values : undefined
}

function nullOnlySchema(raw, root, seen) {
  const node = normalizeNode(raw, root, seen)
  if (node.type === 'null' || node.const === null) return true
  return Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((value) => value === null)
}

function unionDefinition(node, root, seen, types) {
  let mode
  let rawBranches
  if (Array.isArray(node.oneOf)) {
    mode = 'oneOf'
    rawBranches = node.oneOf
  } else if (Array.isArray(node.anyOf)) {
    mode = 'anyOf'
    rawBranches = node.anyOf
  } else if (types.length > 1) {
    mode = 'anyOf'
    rawBranches = types.map((type) => ({ type }))
  } else {
    return undefined
  }

  const base = { ...node }
  delete base.oneOf
  delete base.anyOf
  if (types.length > 1) delete base.type
  const nullable = rawBranches.some((branch) => nullOnlySchema(branch, root, seen))
  const alternatives = rawBranches
    .filter((branch) => !nullOnlySchema(branch, root, seen))
    .map((branch) => valueSchema(mergeSchema(base, normalizeNode(branch, root, seen)), root, seen))
  return { mode, alternatives, nullable }
}

function valueSchema(raw, root, seen = new Set()) {
  const node = normalizeNode(raw, root, seen)
  const enums = enumValues(node)
  const rawType = Array.isArray(node.type) ? node.type : node.type ? [node.type] : []
  const union = enums?.length ? undefined : unionDefinition(node, root, seen, rawType.filter((type) => type !== 'null'))
  const nullable = rawType.includes('null') || enums?.includes(null) || union?.nullable
  const types = rawType.filter((type) => type !== 'null')
  if (union && union.alternatives.length === 0 && nullable) return { kind: 'enum', nullable: true, enum: [null] }
  if (union?.alternatives.length === 1) return { ...union.alternatives[0], ...(nullable ? { nullable: true } : {}) }
  let kind = 'any'
  if (enums?.length) kind = 'enum'
  else if (union) kind = 'union'
  else if (types.length === 1 && ['boolean', 'string', 'number', 'integer', 'array', 'object'].includes(types[0])) kind = types[0]
  else if (node.properties || node.additionalProperties !== undefined || node.patternProperties) kind = node.additionalProperties && !node.properties ? 'map' : 'object'
  else if (node.items) kind = 'array'
  const schema = { kind, ...(nullable ? { nullable: true } : {}) }
  if (enums?.length) schema.enum = enums
  if (union) {
    schema.alternatives = union.alternatives
    schema.unionMode = union.mode
  }
  if (typeof node.minimum === 'number') schema.minimum = node.minimum
  if (typeof node.maximum === 'number') schema.maximum = node.maximum
  if (typeof node.pattern === 'string') schema.pattern = node.pattern
  if (node.items) schema.item = valueSchema(node.items, root, seen)
  if (isObject(node.properties)) {
    schema.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, valueSchema(child, root, seen)]))
  }
  if (Array.isArray(node.required)) schema.required = [...new Set(node.required.filter((key) => typeof key === 'string' && key))]
  if (node.additionalProperties !== undefined) {
    schema.additional = isObject(node.additionalProperties) ? valueSchema(node.additionalProperties, root, seen) : node.additionalProperties !== false
  } else if (node.patternProperties) {
    const first = Object.values(node.patternProperties)[0]
    schema.additional = first ? valueSchema(first, root, seen) : true
  }
  return schema
}

function descriptionOf(node) {
  return String(node.markdownDescription ?? node.description ?? '').replace(/\s+/g, ' ').trim()
}

function containsSensitiveProperty(raw, root, seen = new Set()) {
  if (!isObject(raw) || seen.has(raw)) return false
  seen.add(raw)
  const node = normalizeNode(raw, root)
  const children = []
  if (isObject(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      if (secretShapedName(key) && secretCapableSchema(child, root)) return true
      if (isObject(child)) children.push(child)
    }
  }
  if (isObject(node.additionalProperties)) children.push(node.additionalProperties)
  if (isObject(node.patternProperties)) children.push(...Object.values(node.patternProperties).filter(isObject))
  if (isObject(node.items)) children.push(node.items)
  for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
    if (isObject(branch)) children.push(branch)
  }
  return children.some((child) => containsSensitiveProperty(child, root, seen))
}

function categoryOf(path, node) {
  const explicit = node.category ?? node['x-category'] ?? node.group
  const description = descriptionOf(node)
  const markdownCategory = /(?:^|\b)Category:\s*`([^`]+)`/i.exec(description)
  const match = /(?:^|\b)Category:\s*([^.;–—-]+)/i.exec(description)
  const supplied = typeof explicit === 'string' && explicit.trim()
    ? explicit.trim()
    : markdownCategory?.[1]?.trim() || match?.[1]?.trim() || ''
  const key = dotted(path).toLowerCase()
  const haystack = `${key} ${supplied.toLowerCase()} ${description.toLowerCase()}`
  if (/(?:auth|credential|api.?key|token|secret|login|account)/.test(haystack)) return 'Authentication & accounts'
  if (/(?:permission|approval|trust|policy|allowlist|denylist|dangerous)/.test(haystack)) return 'Permissions & approvals'
  if (/(?:model|reasoning|thinking|temperature|sampling|effort)/.test(haystack)) return 'Models & reasoning'
  if (/(?:mcp|tool|plugin|extension|integration)/.test(haystack)) return 'Tools & integrations'
  if (/(?:agent|subagent|skill|task|todo|worker|swarm)/.test(haystack)) return 'Agents & automation'
  if (/(?:context|memory|compact|history|session|transcript|cache)/.test(haystack)) return 'Context & memory'
  if (/(?:hook|notif|bell|sound|statusline|status.line|attention)/.test(haystack)) return 'Notifications & hooks'
  if (/(?:sandbox|shell|command|exec|process|terminal|pty)/.test(haystack)) return 'Execution & sandbox'
  if (/(?:network|proxy|domain|browser|web|http|url|tls|ssl)/.test(haystack)) return 'Network & web'
  if (/(?:theme|color|display|layout|tui|ui\.|editor|output|input|scroll|keybind)/.test(haystack)) return 'Interface & terminal'
  if (/(?:git|repo|project|workspace|file|path|directory|folder)/.test(haystack)) return 'Projects & files'
  if (/(?:telemetry|analytics|metric|usage|update|version|diagnostic|log)/.test(haystack)) return 'Telemetry & updates'
  if (/(?:experimental|feature|preview|deprecated|legacy)/.test(haystack)) return 'Advanced & experimental'
  return 'General'
}

function activationOf(node) {
  const text = descriptionOf(node)
  const explicit = /requires? restart:\s*(yes|true|no|false)/i.exec(text)
  if (explicit) return /^(?:yes|true)$/i.test(explicit[1]) ? 'restart' : 'live'
  if (/requires? (?:a )?restart/i.test(text)) return 'restart'
  if (/next session|on startup|at startup|when .* starts?/i.test(text)) return 'next-session'
  return 'unknown'
}

function pathStarts(path, candidate) {
  return path.length >= candidate.length && candidate.every((part, index) => path[index] === part)
}

function classify(provider, path, node, root = node) {
  const key = dotted(path)
  let scopes = [...DEFAULT_SCOPES[provider]]
  let stability = node.deprecated || /\bdeprecated\b/i.test(descriptionOf(node)) ? 'deprecated' : path.includes('experimental') || /^experimental[._]/i.test(key) ? 'experimental' : 'stable'
  let sensitive = secretShapedName(key) && secretCapableSchema(node, root)
  let writable = true
  let writeReason
  let editor = 'control'
  let workspaceOwner
  let danger

  if (/^(?:mcpServers|mcp_servers|mcp)(?:\.|$)/.test(key)) {
    workspaceOwner = 'integrations'
    writable = false
    editor = 'dedicated'
    writeReason = 'Managed in Settings → Integrations.'
  }
  if (key === 'statusLine' || key.startsWith('statusLine.')) {
    workspaceOwner = 'context'
    writable = false
    editor = 'dedicated'
    writeReason = 'Workspace owns this launch overlay for the live context meter.'
  }
  const notificationOwned = provider === 'claude'
    ? /^(?:hooks|preferredNotifChannel)(?:\.|$)/.test(key)
    : provider === 'codex'
      ? /^(?:notify|tui\.notifications|tui\.notification_method|tui\.notification_condition)(?:\.|$)/.test(key)
      : provider === 'gemini'
        ? /^(?:hooks|general\.enableNotifications)(?:\.|$)/.test(key)
        : provider === 'aider'
          ? /^(?:notifications|notifications-command)$/.test(key)
          : /^(?:attention)(?:\.|$)/.test(key)
  if (notificationOwned) {
    workspaceOwner = 'notifications'
    writable = false
    editor = 'dedicated'
    writeReason = 'Workspace owns this launch overlay so pane attention remains accurate.'
  }
  const dynamic = node.additionalProperties !== undefined && node.additionalProperties !== false || isObject(node.patternProperties)
  if (dynamic && !workspaceOwner) {
    writable = false
    editor = 'dedicated'
    writeReason = 'Named entries need a preservation-safe dedicated editor.'
  }
  if (executableCallback(path, node, root) && !workspaceOwner) {
    writable = false
    editor = 'dedicated'
    writeReason = 'Executable callbacks require a dedicated reviewed workflow.'
  }
  if (sensitive) {
    writable = false
    editor = 'read-only'
    workspaceOwner = 'authentication'
    writeReason = 'Authentication and secret values remain provider-owned.'
  }

  if (provider === 'claude') {
    if (CLAUDE_MANAGED_ONLY.has(key)) scopes = ['system-policy']
    if (['skipDangerousModePermissionPrompt', 'useAutoModeDuringPlan'].includes(key)) scopes = scopes.filter((scope) => scope !== 'project')
    if (key.startsWith('autoMode.')) scopes = scopes.filter((scope) => scope !== 'project')
    if (key === 'sandbox.allowAppleEvents' || key === 'footerLinksRegexes') scopes = scopes.filter((scope) => scope !== 'project' && scope !== 'local')
    if (key === 'askUserQuestionTimeout') scopes = ['user']
    if (key === 'permissions.defaultMode' || key === 'sandbox.allowUnsandboxedCommands') danger = 'permission-bypass'
  } else if (provider === 'codex') {
    if (CODEX_PROJECT_DENY.some((prefix) => key === prefix || key.startsWith(prefix + '.'))) scopes = scopes.filter((scope) => scope !== 'project')
    if (/^(?:notice|projects|desktop)(?:\.|$)/.test(key)) {
      writable = false
      editor = 'read-only'
      writeReason = 'This is provider-owned state and is preserved unchanged.'
    }
    if (key === 'profile' || key === 'profiles' || key.startsWith('profiles.')) {
      stability = 'deprecated'
      writable = false
      editor = 'read-only'
      writeReason = 'Current Codex versions use separate named profile files; legacy profile keys are ignored.'
    }
    if (key === 'approval_policy' || key === 'sandbox_mode' || key === 'default_permissions') danger = 'permission-bypass'
  } else if (provider === 'gemini') {
    if (path[0] === 'admin') {
      scopes = ['system-policy']
      writable = false
      editor = 'read-only'
      writeReason = 'Enterprise admin state is remote and read-only.'
    }
    if (key === 'general.defaultApprovalMode' || key === 'tools.allowed' || key === 'tools.exclude') danger = 'permission-bypass'
    if (/^tools\.sandboxNetworkAccess(?:\.|$)/.test(key)) danger = 'network'
  } else if (provider === 'aider') {
    if (path[0] === 'set-env' || path[0] === 'api-key') {
      sensitive = true
      writable = false
      editor = 'read-only'
      workspaceOwner = 'authentication'
      writeReason = 'This option can contain provider credentials or other secret environment values.'
    }
    if (AIDER_ONE_SHOT.has(path[0])) {
      scopes = ['session']
      writable = false
      editor = 'dedicated'
      writeReason = 'This is a one-shot CLI action, not a persistent preference.'
    }
    if (AIDER_META_OPTIONS.has(path[0])) {
      scopes = ['session']
      writable = false
      editor = 'dedicated'
      writeReason = 'This option selects which configuration file Aider loads; it is not a durable preference inside that file.'
    }
    if (AIDER_DEPRECATED.has(path[0])) stability = 'deprecated'
  } else if (provider === 'opencode') {
    // A managed origin locks any field dynamically; there is no static managed-only list.
    if (path.includes('permission')) danger = 'permission-bypass'
  }

  return { scopes, stability, sensitive, writable, editor, ...(writeReason ? { writeReason } : {}), ...(workspaceOwner ? { workspaceOwner } : {}), ...(danger ? { danger } : {}) }
}

function descriptor(provider, surface, path, raw, root, sourceUrl) {
  const node = normalizeNode(raw, root)
  const classification = classify(provider, path, node, root)
  if (containsSensitiveProperty(node, root)) {
    classification.sensitive = true
    classification.writable = false
    classification.editor = 'read-only'
    classification.workspaceOwner = 'authentication'
    classification.writeReason = 'This structured value contains provider-owned authentication fields.'
  }
  const schema = valueSchema(node, root)
  const publishedDefault = node.default !== undefined && JSON.stringify(node.default).length < 16_384
    ? clone(node.default)
    : undefined
  const setting = {
    id: idFor(provider, surface, path),
    provider,
    surface,
    path,
    title: String(node.title ?? humanize(path[path.length - 1] ?? 'Setting')),
    description: descriptionOf(node) || `Configure ${dotted(path)}.`,
    category: categoryOf(path, node),
    schema,
    ...(publishedDefault !== undefined && reducedSchemaMatches(publishedDefault, schema) ? { defaultValue: publishedDefault } : {}),
    activation: activationOf(node),
    sourceUrl,
    ...classification
  }
  return setting
}

function flatten(provider, surface, raw, root, sourceUrl, path, output, refStack = new Set()) {
  const node = normalizeNode(raw, root, refStack)
  const properties = isObject(node.properties) ? node.properties : undefined
  const dynamic = node.additionalProperties !== undefined && node.additionalProperties !== false || isObject(node.patternProperties)
  const union = Array.isArray(node.oneOf) || Array.isArray(node.anyOf)
  const array = node.type === 'array' || !!node.items

  if (path.length && (array || union || !properties || dynamic)) output.push(descriptor(provider, surface, path, node, root, sourceUrl))
  if (properties) {
    for (const [key, child] of Object.entries(properties)) flatten(provider, surface, child, root, sourceUrl, [...path, key], output, refStack)
  }
  if (dynamic && path.length) {
    const extra = isObject(node.additionalProperties)
      ? node.additionalProperties
      : isObject(node.patternProperties) ? Object.values(node.patternProperties)[0] : {}
    output.push({
      ...descriptor(provider, surface, [...path, '*'], extra ?? {}, root, sourceUrl),
      title: `${humanize(path[path.length - 1])} entry`,
      writable: false,
      editor: 'dedicated',
      writeReason: 'Add and edit entries through the parent structured map control.'
    })
  }
}

export function compileJsonSchemaCatalog({ provider, surface = 'runtime', schema, sourceUrl, checkedAt = Date.now(), installedVersion }) {
  if (!PROVIDER_NAMES[provider]) throw new Error(`Unknown provider ${provider}`)
  if (!isObject(schema)) throw new Error(`${provider}/${surface} schema root is not an object`)
  const root = schema
  const normalizedRoot = normalizeNode(schema, root)
  const settings = []
  flatten(provider, surface, normalizedRoot, root, sourceUrl, [], settings)
  const unique = new Map()
  for (const setting of settings) {
    if (unique.has(setting.id)) throw new Error(`Duplicate catalog id ${setting.id}`)
    unique.set(setting.id, setting)
  }
  const rows = [...unique.values()].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  return {
    provider,
    providerName: PROVIDER_NAMES[provider],
    catalogVersion: sha256(JSON.stringify(rows)),
    generatedAt: checkedAt,
    ...(installedVersion ? { installedVersion } : {}),
    stale: false,
    sources: [{ url: sourceUrl, checkedAt, ...(installedVersion ? { version: installedVersion } : {}), exactVersion: !!installedVersion }],
    categories: [...new Set(rows.map((row) => row.category))],
    settings: rows
  }
}

function parseAiderDefault(description) {
  const match = /\(default:\s*([^\)]+)\)/i.exec(description)
  if (!match) return undefined
  const value = match[1].trim()
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (/^(?:none|not set|depends|platform)$/i.test(value)) return undefined
  return value.replace(/^['"]|['"]$/g, '')
}

function decodeHtml(value) {
  return String(value)
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|ul|ol|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&(?:nbsp|ensp|emsp);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&rsquo;/gi, '’')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

function aiderHelpMetadata(help) {
  if (typeof help !== 'string' || !/usage:\s*aider\b/i.test(decodeHtml(help))) {
    throw new Error('Aider option reference does not contain its usage summary')
  }
  const options = new Map()
  const blocks = help.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>\s*([\s\S]*?)(?=<h[23]\b|$)/gi)
  for (const match of blocks) {
    const heading = decodeHtml(match[1])
    const option = /(?:^|\s)--([a-z0-9][a-z0-9-]*)(?:\s+([^\s]+))?/i.exec(heading)
    if (!option || options.has(option[1])) continue
    const body = decodeHtml(match[2])
    const environmentVariable = /Environment variable:\s*`?([A-Z][A-Z0-9_]*)`?/i.exec(body)?.[1]
    const rawDefault = /(?:^|\n|\s)Default:\s*(.*?)(?=\n|\s+Environment variable:|$)/i.exec(body)?.[1]?.trim()
    const description = body
      .replace(/(?:^|\n|\s)Default:\s*.*?(?=\n|\s+Environment variable:|$)/gi, '')
      .replace(/(?:^|\n|\s)Environment variable:\s*[^\n]+/gi, '')
      .replace(/(?:^|\n)Aliases:[\s\S]*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
    options.set(option[1], {
      description,
      ...(environmentVariable ? { environmentVariable } : {}),
      ...(rawDefault ? { rawDefault } : {}),
      repeatable: /can be used multiple times/i.test(body) || rawDefault === '[]'
    })
  }
  if (options.size < 100 || !['map-tokens', 'read', 'file', 'config'].every((key) => options.has(key))) {
    throw new Error(`Aider option reference yielded only ${options.size} usable options`)
  }
  return options
}

function aiderDefault(raw, description) {
  if (typeof raw !== 'string') return parseAiderDefault(description)
  const value = raw.trim()
  if (value === '[]') return []
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (/^(?:none|not set|depends|platform)$/i.test(value)) return undefined
  return value.replace(/^['"]|['"]$/g, '')
}

export function compileAiderSampleCatalog({
  sample,
  sourceUrl,
  help,
  helpSourceUrl,
  checkedAt = Date.now(),
  helpCheckedAt = checkedAt,
  installedVersion
}) {
  if (typeof sample !== 'string' || !sample.includes('.aider.conf.yml')) throw new Error('Aider sample does not look like the official all-options file')
  const helpOptions = aiderHelpMetadata(help)
  let category = 'General'
  let description = ''
  const rows = []
  const seen = new Set()
  for (const line of sample.split(/\r?\n/)) {
    const heading = /^#\s+([^#].*?):\s*$/.exec(line)
    if (heading && !line.startsWith('##')) {
      category = heading[1].trim()
      continue
    }
    const doc = /^##\s*(.+)$/.exec(line)
    if (doc) {
      description = doc[1].trim()
      continue
    }
    const option = /^#([a-z0-9][a-z0-9-]*):\s*(.*)$/.exec(line)
    if (!option || seen.has(option[1])) continue
    const key = option[1]
    seen.add(key)
    const raw = option[2].trim()
    const helpOption = helpOptions.get(key)
    if (!helpOption) throw new Error(`Aider option reference is missing sample key ${key}`)
    const documentedDescription = helpOption.description || description
    const defaultValue = AIDER_META_OPTIONS.has(key) ? undefined : aiderDefault(helpOption.rawDefault, documentedDescription)
    let schema = { kind: 'string' }
    const numericKind = AIDER_NUMERIC_OPTIONS.get(key)
    if (helpOption.repeatable || AIDER_REPEATABLE_OPTIONS.has(key)) schema = { kind: 'array', item: { kind: 'string' } }
    else if (numericKind) schema = { kind: numericKind }
    else if (/^(?:true|false)$/i.test(raw) || typeof defaultValue === 'boolean') schema = { kind: 'boolean' }
    else if (/^-?\d+(?:\.\d+)?$/.test(raw) || typeof defaultValue === 'number') schema = { kind: Number.isInteger(Number(raw || defaultValue)) ? 'integer' : 'number' }
    const choices = /(?:options?|choices?)\s*:\s*([^.;\)]+)/i.exec(documentedDescription)?.[1]
    if (choices) {
      const values = choices.split(/,|\bor\b/i).map((value) => value.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean)
      if (values.length > 1 && values.length < 32) schema = { kind: 'enum', enum: values }
    }
    const classification = classify('aider', [key], {
      description: documentedDescription,
      deprecated: AIDER_DEPRECATED.has(key),
      type: schema.kind === 'enum' ? 'string' : schema.kind
    })
    rows.push({
      id: idFor('aider', 'runtime', [key]),
      provider: 'aider',
      surface: 'runtime',
      path: [key],
      title: humanize(key),
      description: documentedDescription || `Configure ${key}.`,
      category: categoryOf([key], { category, description: documentedDescription }),
      schema,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      activation: 'next-session',
      sourceUrl,
      cliFlag: `--${key}`,
      environmentVariable: helpOption.environmentVariable ?? `AIDER_${key.replace(/-/g, '_').toUpperCase()}`,
      ...classification
    })
    description = ''
  }
  if (rows.length < 100) throw new Error(`Aider sample yielded only ${rows.length} settings`)
  return {
    provider: 'aider',
    providerName: PROVIDER_NAMES.aider,
    catalogVersion: sha256(JSON.stringify(rows)),
    generatedAt: checkedAt,
    ...(installedVersion ? { installedVersion } : {}),
    stale: false,
    sources: [
      { url: sourceUrl, checkedAt, ...(installedVersion ? { version: installedVersion } : {}), exactVersion: !!installedVersion },
      { url: helpSourceUrl, checkedAt: helpCheckedAt, ...(installedVersion ? { version: installedVersion } : {}), exactVersion: !!installedVersion }
    ],
    categories: [...new Set(rows.map((row) => row.category))],
    settings: rows
  }
}

export function combineCatalogs(catalogs) {
  if (!catalogs.length) throw new Error('No catalogs to combine')
  const provider = catalogs[0].provider
  if (catalogs.some((catalog) => catalog.provider !== provider)) throw new Error('Cannot combine different providers')
  const settings = catalogs.flatMap((catalog) => catalog.settings)
  const ids = new Set()
  for (const setting of settings) {
    if (ids.has(setting.id)) throw new Error(`Duplicate combined catalog id ${setting.id}`)
    ids.add(setting.id)
  }
  return {
    ...catalogs[0],
    catalogVersion: sha256(JSON.stringify(settings)),
    generatedAt: Math.max(...catalogs.map((catalog) => catalog.generatedAt)),
    stale: catalogs.some((catalog) => catalog.stale),
    sources: catalogs.flatMap((catalog) => catalog.sources),
    categories: [...new Set(settings.map((row) => row.category))],
    settings
  }
}

const VALID_SCOPES = new Set(['session', 'project', 'local', 'profile', 'user', 'system-default', 'system-policy'])
const VALID_KINDS = new Set(['boolean', 'string', 'number', 'integer', 'enum', 'array', 'object', 'map', 'any', 'union'])
const VALID_ACTIVATIONS = new Set(['live', 'restart', 'next-session', 'unknown'])
const VALID_STABILITIES = new Set(['stable', 'experimental', 'deprecated', 'internal'])
const CANONICAL_CATEGORIES = new Set([
  'Authentication & accounts', 'Permissions & approvals', 'Models & reasoning',
  'Tools & integrations', 'Agents & automation', 'Context & memory',
  'Notifications & hooks', 'Execution & sandbox', 'Network & web',
  'Interface & terminal', 'Projects & files', 'Telemetry & updates',
  'Advanced & experimental', 'General'
])

function validateValueSchema(schema, context, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1
  if (!isObject(schema) || !VALID_KINDS.has(schema.kind) || depth > 16 || budget.nodes > 4_096) throw new Error(`Invalid schema for ${context}`)
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') throw new Error(`Invalid nullable marker for ${context}`)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256)) throw new Error(`Invalid enum for ${context}`)
  if (schema.kind === 'enum' && !schema.enum?.length) throw new Error(`Missing enum values for ${context}`)
  if (schema.minimum !== undefined && !Number.isFinite(schema.minimum) || schema.maximum !== undefined && !Number.isFinite(schema.maximum)) {
    throw new Error(`Invalid numeric bounds for ${context}`)
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) throw new Error(`Inverted numeric bounds for ${context}`)
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new Error(`Invalid pattern for ${context}`)
    try { new RegExp(schema.pattern) } catch { throw new Error(`Invalid pattern for ${context}`) }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties) || Object.keys(schema.properties).length > 512) throw new Error(`Invalid properties for ${context}`)
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`Unsafe schema property for ${context}`)
      validateValueSchema(child, context, depth + 1, budget)
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length > 512 || new Set(schema.required).size !== schema.required.length ||
        schema.required.some((key) => typeof key !== 'string' || !key || ['__proto__', 'prototype', 'constructor'].includes(key))) {
      throw new Error(`Invalid required fields for ${context}`)
    }
  }
  if (isObject(schema.additional)) validateValueSchema(schema.additional, context, depth + 1, budget)
  if (isObject(schema.item)) validateValueSchema(schema.item, context, depth + 1, budget)
  if (schema.kind === 'union') {
    if (!Array.isArray(schema.alternatives) || !schema.alternatives.length || schema.alternatives.length > 64 ||
        !['anyOf', 'oneOf'].includes(schema.unionMode)) throw new Error(`Invalid union for ${context}`)
    for (const alternative of schema.alternatives) validateValueSchema(alternative, context, depth + 1, budget)
  } else if (schema.alternatives !== undefined || schema.unionMode !== undefined) {
    throw new Error(`Union metadata appears on a non-union schema for ${context}`)
  }
}

function reducedSchemaMatches(value, schema, depth = 0, budget = { remaining: 4_096 }) {
  if (!isObject(schema) || depth > 16 || budget.remaining-- <= 0) return false
  if (value === null) return schema.nullable === true
  if (schema.enum?.length && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return false
  if (schema.kind === 'boolean') return typeof value === 'boolean'
  if (schema.kind === 'string') return typeof value === 'string' && (!schema.pattern || new RegExp(schema.pattern).test(value))
  if (schema.kind === 'number' || schema.kind === 'integer') {
    return typeof value === 'number' && Number.isFinite(value) &&
      (schema.kind !== 'integer' || Number.isSafeInteger(value)) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum)
  }
  if (schema.kind === 'enum') return schema.enum?.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)) === true
  if (schema.kind === 'array') {
    return Array.isArray(value) && (!schema.item || value.every((item) => reducedSchemaMatches(item, schema.item, depth + 1, budget)))
  }
  if (schema.kind === 'object' || schema.kind === 'map') {
    if (!isObject(value) || (schema.required ?? []).some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false
    const properties = schema.properties ?? {}
    return Object.entries(value).every(([key, child]) => {
      if (properties[key]) return reducedSchemaMatches(child, properties[key], depth + 1, budget)
      if (schema.additional === false) return false
      return !isObject(schema.additional) || reducedSchemaMatches(child, schema.additional, depth + 1, budget)
    })
  }
  if (schema.kind === 'any') return true
  if (schema.kind === 'union') {
    const matches = schema.alternatives.filter((alternative) => reducedSchemaMatches(value, alternative, depth + 1, budget)).length
    return schema.unionMode === 'oneOf' ? matches === 1 : matches >= 1
  }
  return false
}

function reducedSchemaContainsSecret(schema, seen = new Set()) {
  if (!isObject(schema) || seen.has(schema)) return false
  seen.add(schema)
  if (isObject(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (secretShapedName(key) && !['boolean', 'number', 'integer', 'enum'].includes(child?.kind)) return true
      if (reducedSchemaContainsSecret(child, seen)) return true
    }
  }
  return isObject(schema.additional) && reducedSchemaContainsSecret(schema.additional, seen) ||
    isObject(schema.item) && reducedSchemaContainsSecret(schema.item, seen) ||
    Array.isArray(schema.alternatives) && schema.alternatives.some((alternative) => reducedSchemaContainsSecret(alternative, seen))
}

export function validateCatalog(catalog) {
  if (!isObject(catalog) || !PROVIDER_NAMES[catalog.provider] || catalog.providerName !== PROVIDER_NAMES[catalog.provider] ||
      !Array.isArray(catalog.settings) || !Array.isArray(catalog.sources) || !catalog.sources.length ||
      !Array.isArray(catalog.categories) || typeof catalog.stale !== 'boolean' ||
      !Number.isFinite(catalog.generatedAt) || typeof catalog.catalogVersion !== 'string') throw new Error('Invalid catalog envelope')
  const sourceUrls = new Set()
  for (const source of catalog.sources) {
    if (!isObject(source) || typeof source.url !== 'string' || !source.url.startsWith('https://') ||
        !Number.isFinite(source.checkedAt) || source.checkedAt < 0 || typeof source.exactVersion !== 'boolean') {
      throw new Error(`Invalid ${catalog.provider} catalog source`)
    }
    sourceUrls.add(source.url)
  }
  const ids = new Set()
  for (const row of catalog.settings) {
    if (!isObject(row) || typeof row.id !== 'string' || !Array.isArray(row.path) || !row.path.length) throw new Error(`Invalid ${catalog.provider} catalog row`)
    if (ids.has(row.id)) throw new Error(`Duplicate catalog id ${row.id}`)
    ids.add(row.id)
    if (row.provider !== catalog.provider || !['runtime', 'tui'].includes(row.surface)) throw new Error(`Catalog identity mismatch for ${row.id}`)
    if (row.path.some((part) => typeof part !== 'string' || !part || part.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(part)) ||
        row.id !== idFor(row.provider, row.surface, row.path)) throw new Error(`Catalog id/path mismatch for ${row.id}`)
    validateValueSchema(row.schema, row.id)
    if (Object.prototype.hasOwnProperty.call(row, 'defaultValue') && !reducedSchemaMatches(row.defaultValue, row.schema)) {
      throw new Error(`Default value does not match the reduced schema for ${row.id}`)
    }
    if (!Array.isArray(row.scopes) || !row.scopes.length || row.scopes.some((scope) => !VALID_SCOPES.has(scope)) ||
        new Set(row.scopes).size !== row.scopes.length || typeof row.sensitive !== 'boolean' || typeof row.writable !== 'boolean' ||
        !VALID_ACTIVATIONS.has(row.activation) || !VALID_STABILITIES.has(row.stability) ||
        typeof row.category !== 'string' || !CANONICAL_CATEGORIES.has(row.category) ||
        typeof row.title !== 'string' || typeof row.description !== 'string' || !sourceUrls.has(row.sourceUrl) ||
        row.editor !== undefined && !['control', 'dedicated', 'read-only'].includes(row.editor)) {
      throw new Error(`Missing classification for ${row.id}`)
    }
    const semanticallySensitive = secretShapedName(row.path.join('.')) && !['boolean', 'number', 'integer', 'enum'].includes(row.schema.kind) ||
      reducedSchemaContainsSecret(row.schema)
    if (semanticallySensitive && !row.sensitive) throw new Error(`Sensitive catalog path is not classified for ${row.id}`)
    if (row.sensitive && (row.writable || !['read-only', 'dedicated'].includes(row.editor))) throw new Error(`Sensitive catalog row is writable for ${row.id}`)
    if ((row.path.includes('*') || row.schema.additional !== undefined && row.schema.additional !== false) &&
        (row.writable || !['dedicated', 'read-only'].includes(row.editor))) {
      throw new Error(`Dynamic catalog row needs a dedicated editor for ${row.id}`)
    }
    if (row.workspaceOwner && row.writable) throw new Error(`Workspace-owned catalog row is writable for ${row.id}`)
  }
  if (catalog.provider === 'aider') {
    const rows = new Map(catalog.settings.map((row) => [row.path.join('.'), row]))
    for (const [key, kind] of AIDER_NUMERIC_OPTIONS) {
      if (rows.get(key)?.schema?.kind !== kind) throw new Error(`Aider numeric option ${key} is not ${kind}`)
    }
    for (const key of AIDER_REPEATABLE_OPTIONS) {
      const schema = rows.get(key)?.schema
      if (schema?.kind !== 'array' || schema.item?.kind !== 'string') throw new Error(`Aider repeatable option ${key} is not a string list`)
    }
    const meta = rows.get('config')
    if (!meta || meta.writable || meta.editor !== 'dedicated' || meta.scopes.length !== 1 || meta.scopes[0] !== 'session' || meta.defaultValue !== undefined) {
      throw new Error('Aider config selector is exposed as a durable preference')
    }
    const sourceUrls = new Set(catalog.sources.map((source) => source.url))
    if (!sourceUrls.has('https://aider.chat/docs/config/options.html') ||
        !sourceUrls.has('https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/sample.aider.conf.yml')) {
      throw new Error('Aider catalog does not record both official source artifacts')
    }
  }
  const derivedCategories = [...new Set(catalog.settings.map((row) => row.category))]
  if (derivedCategories.length > 32 || JSON.stringify(catalog.categories) !== JSON.stringify(derivedCategories)) throw new Error(`Invalid ${catalog.provider} catalog taxonomy`)
  if (catalog.catalogVersion !== sha256(JSON.stringify(catalog.settings))) throw new Error(`${catalog.provider} catalog version does not match its settings`)
  return catalog
}

export function validateCatalogBundle(bundle) {
  if (!isObject(bundle) || !isObject(bundle.providers) || typeof bundle.revision !== 'string' || !Number.isFinite(bundle.generatedAt) ||
      Object.keys(bundle.providers).length !== Object.keys(PROVIDER_NAMES).length) throw new Error('Invalid catalog bundle')
  for (const provider of Object.keys(PROVIDER_NAMES)) validateCatalog(bundle.providers[provider])
  const expectedRevision = sha256(JSON.stringify(Object.fromEntries(
    Object.entries(bundle.providers).map(([id, catalog]) => [id, catalog?.catalogVersion])
  )))
  if (bundle.revision !== expectedRevision) throw new Error('Catalog bundle revision does not match its provider catalogs')
  return bundle
}

export const CATALOG_PROVIDER_NAMES = Object.freeze({ ...PROVIDER_NAMES })
