import {
  AGENT_CLI_IDS,
  type AgentCliId,
  type AgentConfigScope,
  type AgentConfigSurface
} from '@contracts'

export type AgentCliConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml'

export interface AgentCliConfigSurfaceDefinition {
  id: AgentConfigSurface
  format: AgentCliConfigFormat
}

export type AgentCliCatalogSourceKind = 'json-schema' | 'aider-help' | 'aider-sample'

/**
 * An allowlisted, inert description of an official catalog source. Downloading,
 * validating, and caching source data belongs to the catalog service.
 */
export interface AgentCliCatalogSourceDefinition {
  id: string
  url: string
  kind: AgentCliCatalogSourceKind
}

/** The provider-native transport used to apply settings to one launched process. */
export type AgentCliSessionOverlay =
  | 'settings-json-argument'
  | 'config-arguments'
  | 'cli-arguments'
  | 'inline-json-environment'

export interface AgentCliConfigCapabilities {
  /** Environment variable that relocates the provider's user configuration home. */
  pointerEnv?: string
  surfaces: readonly AgentCliConfigSurfaceDefinition[]
  /** Real provider layers only; individual catalog entries may support fewer scopes. */
  scopes: readonly AgentConfigScope[]
  catalogSources: readonly AgentCliCatalogSourceDefinition[]
  sessionOverlay: AgentCliSessionOverlay
}

export interface AgentCliDefinition {
  id: AgentCliId
  name: string
  bin: string
  versionArgs: readonly string[]
  resumeArgs?: readonly string[]
  installHint?: string
  config: AgentCliConfigCapabilities
}

/**
 * Canonical launch and configuration capabilities for every supported agent CLI.
 * Keep source descriptors declarative: remote bytes and filesystem targets never
 * belong in this registry.
 */
export const AGENT_CLI_REGISTRY = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    resumeArgs: ['--resume'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    config: {
      pointerEnv: 'CLAUDE_CONFIG_DIR',
      surfaces: [{ id: 'runtime', format: 'json' }],
      scopes: ['session', 'project', 'local', 'profile', 'user', 'system-policy'],
      catalogSources: [
        {
          id: 'claude-settings-schema',
          url: 'https://json.schemastore.org/claude-code-settings.json',
          kind: 'json-schema'
        }
      ],
      sessionOverlay: 'settings-json-argument'
    }
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    versionArgs: ['--version'],
    resumeArgs: ['resume'],
    installHint: 'npm install -g @openai/codex',
    config: {
      pointerEnv: 'CODEX_HOME',
      surfaces: [{ id: 'runtime', format: 'toml' }],
      scopes: ['session', 'project', 'profile', 'user', 'system-default', 'system-policy'],
      catalogSources: [
        {
          id: 'codex-config-schema',
          url: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json',
          kind: 'json-schema'
        }
      ],
      sessionOverlay: 'config-arguments'
    }
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    resumeArgs: ['--resume'],
    installHint: 'npm install -g @google/gemini-cli',
    config: {
      pointerEnv: 'GEMINI_CLI_HOME',
      surfaces: [{ id: 'runtime', format: 'jsonc' }],
      scopes: ['session', 'project', 'profile', 'user', 'system-default', 'system-policy'],
      catalogSources: [
        {
          id: 'gemini-settings-schema',
          url: 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json',
          kind: 'json-schema'
        }
      ],
      sessionOverlay: 'cli-arguments'
    }
  },
  {
    id: 'aider',
    name: 'Aider',
    bin: 'aider',
    versionArgs: ['--version'],
    resumeArgs: ['--restore-chat-history'],
    installHint: 'python -m pip install aider-install && aider-install',
    config: {
      surfaces: [{ id: 'runtime', format: 'yaml' }],
      scopes: ['session', 'project', 'user'],
      catalogSources: [
        {
          id: 'aider-options-help',
          url: 'https://aider.chat/docs/config/options.html',
          kind: 'aider-help'
        },
        {
          id: 'aider-all-options-sample',
          url: 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/assets/sample.aider.conf.yml',
          kind: 'aider-sample'
        }
      ],
      sessionOverlay: 'cli-arguments'
    }
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    versionArgs: ['--version'],
    resumeArgs: ['--continue'],
    installHint: 'npm install -g opencode-ai',
    config: {
      surfaces: [
        { id: 'runtime', format: 'jsonc' },
        { id: 'tui', format: 'jsonc' }
      ],
      scopes: ['session', 'project', 'user', 'system-policy'],
      catalogSources: [
        {
          id: 'opencode-runtime-schema',
          url: 'https://opencode.ai/config.json',
          kind: 'json-schema'
        },
        {
          id: 'opencode-tui-schema',
          url: 'https://opencode.ai/tui.json',
          kind: 'json-schema'
        }
      ],
      sessionOverlay: 'inline-json-environment'
    }
  }
] as const satisfies readonly AgentCliDefinition[]

export function findAgentCliDefinition(id: string): AgentCliDefinition | undefined {
  return AGENT_CLI_REGISTRY.find((definition) => definition.id === id)
}

/**
 * Runtime/static-gate seam: a registry with a duplicate, missing, or unexpected
 * id cannot silently become a second provider vocabulary.
 */
export function validateAgentCliRegistryCoverage(
  registry: readonly { id: string }[] = AGENT_CLI_REGISTRY
): void {
  const canonicalIds = new Set<string>(AGENT_CLI_IDS)
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  const unexpected = new Set<string>()

  for (const definition of registry) {
    if (seen.has(definition.id)) duplicates.add(definition.id)
    seen.add(definition.id)
    if (!canonicalIds.has(definition.id)) unexpected.add(definition.id)
  }

  const missing = AGENT_CLI_IDS.filter((id) => !seen.has(id))
  if (duplicates.size === 0 && unexpected.size === 0 && missing.length === 0) return

  const details = [
    duplicates.size > 0 ? `duplicate: ${[...duplicates].join(', ')}` : undefined,
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    unexpected.size > 0 ? `unexpected: ${[...unexpected].join(', ')}` : undefined
  ].filter((detail): detail is string => detail !== undefined)

  throw new Error(`Agent CLI registry coverage failed (${details.join('; ')})`)
}

validateAgentCliRegistryCoverage()
