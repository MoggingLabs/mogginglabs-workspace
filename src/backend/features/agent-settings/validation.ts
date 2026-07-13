import type { AgentConfigSetting, AgentConfigValue, AgentConfigValueSchema } from '@contracts'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
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

function nameTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function secretShapedName(value: string): boolean {
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

export interface AgentConfigValidationResult {
  ok: boolean
  reason?: string
}

const fail = (reason: string): AgentConfigValidationResult => ({ ok: false, reason })

function equal(a: AgentConfigValue, b: AgentConfigValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function validateShape(value: AgentConfigValue, depth = 0): AgentConfigValidationResult {
  if (depth > 12) return fail('The value is nested too deeply.')
  if (typeof value === 'number' && !Number.isFinite(value)) return fail('Numbers must be finite.')
  if (typeof value === 'string' && value.length > 64 * 1024) return fail('A single text value is too large.')
  if (Array.isArray(value)) {
    if (value.length > 2048) return fail('The list has too many items.')
    for (const item of value) {
      const result = validateShape(item, depth + 1)
      if (!result.ok) return result
    }
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length > 2048) return fail('The map has too many entries.')
    for (const [key, child] of entries) {
      if (!key || key.length > 256 || FORBIDDEN_KEYS.has(key)) return fail('The map contains an unsafe key.')
      if (secretShapedName(key)) return fail('Authentication and secret-shaped map entries stay provider-owned.')
      const result = validateShape(child, depth + 1)
      if (!result.ok) return result
    }
  }
  return { ok: true }
}

export function agentConfigValueContainsSecretKey(value: AgentConfigValue | undefined): boolean {
  if (value === undefined || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(agentConfigValueContainsSecretKey)
  return Object.entries(value).some(([key, child]) => secretShapedName(key) || agentConfigValueContainsSecretKey(child))
}

const MAX_SCHEMA_DEPTH = 16
const MAX_SCHEMA_NODES = 4_096

interface ValidationBudget {
  remaining: number
}

function validateSchema(
  value: AgentConfigValue,
  schema: AgentConfigValueSchema,
  depth = 0,
  budget: ValidationBudget = { remaining: MAX_SCHEMA_NODES }
): AgentConfigValidationResult {
  if (depth > MAX_SCHEMA_DEPTH || budget.remaining-- <= 0) return fail('The provider schema is too complex to validate safely.')
  if (value === null) return schema.nullable ? { ok: true } : fail('This setting does not accept null.')
  if (schema.enum?.length && !schema.enum.some((candidate) => equal(candidate, value))) {
    return fail('The value is not one of the provider-supported options.')
  }
  switch (schema.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true } : fail('This setting requires on or off.')
    case 'string':
      if (typeof value !== 'string') return fail('This setting requires text.')
      if (schema.pattern) {
        try {
          if (!new RegExp(schema.pattern).test(value)) return fail('The text does not match the provider-required format.')
        } catch {
          return fail('The catalog contains an invalid validation pattern.')
        }
      }
      return { ok: true }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('This setting requires a finite number.')
      if (schema.kind === 'integer' && !Number.isInteger(value)) return fail('This setting requires a whole number.')
      if (schema.kind === 'integer' && !Number.isSafeInteger(value)) return fail('This integer is outside the exact range Workspace can preserve.')
      if (schema.minimum !== undefined && value < schema.minimum) return fail(`The value must be at least ${schema.minimum}.`)
      if (schema.maximum !== undefined && value > schema.maximum) return fail(`The value must be at most ${schema.maximum}.`)
      return { ok: true }
    }
    case 'enum':
      return schema.enum?.some((candidate) => equal(candidate, value))
        ? { ok: true }
        : fail('The value is not one of the provider-supported options.')
    case 'array':
      if (!Array.isArray(value)) return fail('This setting requires a list.')
      if (schema.item) {
        for (const item of value) {
          const result = validateSchema(item, schema.item, depth + 1, budget)
          if (!result.ok) return result
        }
      }
      return { ok: true }
    case 'object':
    case 'map': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('This setting requires a structured map.')
      const properties = schema.properties ?? {}
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return fail(`The structured value is missing required field “${key}”.`)
      }
      for (const [key, child] of Object.entries(value)) {
        const childSchema = properties[key]
        if (childSchema) {
          const result = validateSchema(child, childSchema, depth + 1, budget)
          if (!result.ok) return fail(`${key}: ${result.reason}`)
        } else if (schema.additional === false) {
          return fail(`The provider does not recognize “${key}” in this setting.`)
        } else if (typeof schema.additional === 'object') {
          const result = validateSchema(child, schema.additional, depth + 1, budget)
          if (!result.ok) return fail(`${key}: ${result.reason}`)
        }
      }
      return { ok: true }
    }
    case 'any':
      return { ok: true }
    case 'union': {
      if (!schema.alternatives?.length) return fail('The provider catalog does not describe the supported forms for this setting.')
      const results = schema.alternatives.map((alternative) => validateSchema(value, alternative, depth + 1, budget))
      const matches = results.filter((result) => result.ok).length
      if (schema.unionMode === 'oneOf' ? matches === 1 : matches >= 1) return { ok: true }
      if (schema.unionMode === 'oneOf' && matches > 1) return fail('The value ambiguously matches more than one provider-supported form.')
      const reasons = [...new Set(results.map((result) => result.reason).filter((reason): reason is string => !!reason))]
        .slice(0, 3)
        .join(' ')
      return fail(`The value does not match any provider-supported form.${reasons ? ` ${reasons}` : ''}`)
    }
  }
  return fail('The provider catalog contains an unsupported value schema.')
}

/** Defense-in-depth beyond catalog classification: a compromised schema cannot
 *  turn an auth-shaped path into an ordinary persisted/IPC-readable setting. */
function secretShaped(setting: AgentConfigSetting): boolean {
  return secretShapedName(setting.path.join('.'))
}

export function validateAgentConfigMutation(
  setting: AgentConfigSetting,
  value: AgentConfigValue | undefined,
  operation: 'set' | 'unset'
): AgentConfigValidationResult {
  if (!setting.writable || setting.editor === 'read-only') {
    return fail(setting.writeReason || 'This provider setting is observable but not writable here.')
  }
  if (setting.sensitive || setting.workspaceOwner === 'authentication' || secretShaped(setting)) {
    return fail('Authentication and secret values stay owned by the provider and never enter Workspace settings.')
  }
  if (setting.path.length === 0 || setting.path.some((part) => !part || part.length > 256 || part === '*' || FORBIDDEN_KEYS.has(part))) {
    return fail('This dynamic or unsafe catalog path needs a dedicated structured editor.')
  }
  if (operation === 'unset') return { ok: true }
  if (value === undefined) return fail('A value is required when setting this option.')
  const shape = validateShape(value)
  return shape.ok ? validateSchema(value, setting.schema) : shape
}
