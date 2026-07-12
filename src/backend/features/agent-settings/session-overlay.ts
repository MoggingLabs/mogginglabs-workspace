import type {
  AgentConfigCatalog,
  AgentConfigOverrideRecord,
  AgentConfigProviderId,
  AgentConfigValue
} from '@contracts'
import { validateAgentConfigMutation } from './validation'

export interface PreparedAgentSessionOverlay {
  runtime: Record<string, AgentConfigValue>
  tui: Record<string, AgentConfigValue>
  args: string[]
  env: Record<string, string>
  settingIds: string[]
  issues: string[]
}

function safeSegment(segment: string): boolean {
  return !!segment && segment !== '*' && segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor'
}

function assignPath(root: Record<string, AgentConfigValue>, path: string[], value: AgentConfigValue): boolean {
  if (!path.length || path.some((segment) => !safeSegment(segment))) return false
  let current = root
  for (const segment of path.slice(0, -1)) {
    const prior = current[segment]
    if (prior === undefined) {
      const child: Record<string, AgentConfigValue> = {}
      current[segment] = child
      current = child
    } else if (prior !== null && !Array.isArray(prior) && typeof prior === 'object') {
      current = prior
    } else {
      return false
    }
  }
  current[path[path.length - 1]] = value
  return true
}

function tomlKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)
}

function tomlLiteral(value: AgentConfigValue): string {
  if (value === null) throw new Error('TOML has no null value')
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    // Unicode escapes survive TOML parsing while preventing cmd.exe from
    // expanding %VAR% or delayed !VAR! inside the interactive launch line.
    return JSON.stringify(value).replace(/%/g, '\\u0025').replace(/!/g, '\\u0021')
  }
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(', ')}]`
  return `{ ${Object.entries(value).map(([key, child]) => `${tomlKey(key)} = ${tomlLiteral(child)}`).join(', ')} }`
}

function aiderArgs(flag: string, value: AgentConfigValue): string[] {
  if (typeof value === 'boolean') return [value ? flag : `--no-${flag.replace(/^--/, '')}`]
  if (Array.isArray(value)) return value.flatMap((entry) => [flag, typeof entry === 'string' ? entry : JSON.stringify(entry)])
  if (value !== null && typeof value === 'object') return [flag, JSON.stringify(value)]
  return [flag, value === null ? 'null' : String(value)]
}

/** Compile validated session intent into provider-native, launch-only material. */
export function prepareAgentSessionOverlay(
  provider: AgentConfigProviderId,
  rows: AgentConfigOverrideRecord[],
  catalog: AgentConfigCatalog
): PreparedAgentSessionOverlay {
  const out: PreparedAgentSessionOverlay = {
    runtime: {},
    tui: {},
    args: [],
    env: {},
    settingIds: [],
    issues: []
  }
  for (const row of rows) {
    const setting = catalog.settings.find((candidate) => candidate.id === row.settingId)
    if (!setting || setting.provider !== provider || JSON.stringify(setting.path) !== JSON.stringify(row.path)) {
      out.issues.push(`A saved next-launch setting no longer exists: ${row.settingId}`)
      continue
    }
    if (row.operation !== 'set') {
      out.issues.push(`${setting.title} cannot remove a lower-precedence value for one session; release the override instead.`)
      continue
    }
    const validation = validateAgentConfigMutation(setting, row.desiredValue, 'set')
    if (!validation.ok) {
      out.issues.push(`${setting.title}: ${validation.reason}`)
      continue
    }
    const value = row.desiredValue as AgentConfigValue
    try {
      if (provider === 'codex') {
        out.args.push('-c', `${setting.path.map(tomlKey).join('.')}=${tomlLiteral(value)}`)
      } else if (provider === 'aider') {
        out.args.push(...aiderArgs(setting.cliFlag ?? `--${setting.path[0]}`, value))
      } else {
        const target = setting.surface === 'tui' ? out.tui : out.runtime
        if (!assignPath(target, setting.path, value)) throw new Error('the setting path cannot be represented safely')
      }
      out.settingIds.push(setting.id)
    } catch (error) {
      out.issues.push(`${setting.title}: ${error instanceof Error ? error.message : 'could not be represented'}`)
    }
  }
  return out
}
