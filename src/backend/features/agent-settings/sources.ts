import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  AgentConfigProviderId,
  AgentConfigScope,
  AgentConfigSurface,
  AgentConfigTarget,
  AgentExecutionTarget
} from '@contracts'

export type AgentConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml'
export type AgentConfigMerge = 'replace' | 'deep' | 'deep-concat-arrays'

export interface AgentConfigPathContext {
  home?: string
  cwd?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Saved profile pointers override the app process environment. */
  profileEnv?: Record<string, string>
  /** True even for the first profile, whose pointer set is intentionally empty. */
  profile?: boolean
  execution?: AgentExecutionTarget
}

export interface AgentConfigSource {
  provider: AgentConfigProviderId
  scope: AgentConfigScope
  surface: AgentConfigSurface
  format: AgentConfigFormat
  label: string
  /** Higher values win for ordinary scalar settings. */
  precedence: number
  merge: AgentConfigMerge
  writable: boolean
  reason?: string
  /** This document constrains values but is not itself a value layer. */
  constraintOnly?: boolean
  /** Backend-only. Never return this descriptor directly over IPC. */
  file?: string
  /** Alternative filenames are checked in order before `file` is created. */
  candidates?: string[]
  /** In-memory provider layer such as OPENCODE_CONFIG_CONTENT. Never persisted. */
  inlineText?: string
}

const localExecution = (ctx: AgentConfigPathContext): boolean => (ctx.execution?.kind ?? 'local') === 'local'

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return isAbsolute(value) ? value : resolve(home, value)
}

const pointer = (ctx: AgentConfigPathContext, name: string, fallback: string): string => {
  const home = ctx.home ?? homedir()
  const value = ctx.profileEnv?.[name] ?? ctx.env?.[name]
  return value ? expandHome(value, home) : join(home, fallback)
}

function geminiConfigHome(ctx: AgentConfigPathContext): string {
  const home = ctx.home ?? homedir()
  const profileRoot = ctx.profileEnv?.GEMINI_CLI_HOME
  if (profileRoot) return join(expandHome(profileRoot, home), '.gemini')
  const profileLegacy = ctx.profileEnv?.GEMINI_CONFIG_DIR
  if (profileLegacy) return expandHome(profileLegacy, home)
  const root = ctx.env?.GEMINI_CLI_HOME
  if (root) return join(expandHome(root, home), '.gemini')
  const legacy = ctx.env?.GEMINI_CONFIG_DIR
  if (legacy) return expandHome(legacy, home)
  return join(home, '.gemini')
}

function configBase(ctx: AgentConfigPathContext): string {
  const home = ctx.home ?? homedir()
  const env = ctx.env ?? process.env
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

function expandCustom(value: string, ctx: AgentConfigPathContext): string {
  const home = ctx.home ?? homedir()
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\') || isAbsolute(value)) return expandHome(value, home)
  return resolve(ctx.cwd ?? home, value)
}

function traversalDirectories(cwd: string | undefined): string[] {
  if (!cwd) return []
  const chain: string[] = []
  let current = resolve(cwd)
  let root = current
  while (true) {
    chain.push(current)
    if (existsSync(join(current, '.git'))) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const rootIndex = chain.indexOf(root)
  return chain.slice(0, rootIndex + 1).reverse()
}

function ancestorDirectories(cwd: string | undefined): string[] {
  if (!cwd) return []
  const chain: string[] = []
  let current = resolve(cwd)
  while (true) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) return chain.reverse()
    current = parent
  }
}

function nearestGitRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  let current = resolve(cwd)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

const projectFile = (ctx: AgentConfigPathContext, ...parts: string[]): string | undefined =>
  ctx.cwd ? join(ctx.cwd, ...parts) : undefined

function systemPath(ctx: AgentConfigPathContext, provider: AgentConfigProviderId, kind: 'default' | 'policy'): string | undefined {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  if (provider === 'claude' && kind === 'policy') {
    if (platform === 'win32') return join(env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
    if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
    return '/etc/claude-code/managed-settings.json'
  }
  if (provider === 'codex') {
    if (kind === 'default') return platform === 'win32'
      ? join(env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'config.toml')
      : '/etc/codex/config.toml'
    if (kind === 'policy') {
      return platform === 'win32'
        ? join(env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex', 'requirements.toml')
        : '/etc/codex/requirements.toml'
    }
  }
  if (provider === 'gemini') {
    const configured = kind === 'default' ? env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH : env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
    if (configured) return expandCustom(configured, ctx)
    const name = kind === 'default' ? 'system-defaults.json' : 'settings.json'
    if (platform === 'win32') return join(env.ProgramData || 'C:\\ProgramData', 'gemini-cli', name)
    if (platform === 'darwin') return join('/Library/Application Support/GeminiCli', name)
    return join('/etc/gemini-cli', name)
  }
  if (provider === 'opencode' && kind === 'policy') {
    if (platform === 'win32') return join(env.ProgramData || 'C:\\ProgramData', 'opencode', 'opencode.json')
    if (platform === 'darwin') return '/Library/Application Support/opencode/opencode.json'
    return '/etc/opencode/opencode.json'
  }
  return undefined
}

function claudeManagedDropIns(ctx: AgentConfigPathContext): string[] {
  const base = systemPath(ctx, 'claude', 'policy')
  if (!base) return []
  const directory = join(dirname(base), 'managed-settings.d')
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

interface FileSourceSpec {
  provider: AgentConfigProviderId
  scope: AgentConfigScope
  surface: AgentConfigSurface
  format: AgentConfigFormat
  label: string
  precedence: number
  merge: AgentConfigMerge
  file: string | undefined
  writable: boolean
  reason?: string
  candidates?: string[]
}

// Named fields, not eleven positional slots: the call sites below are a table of
// provider layers, and a table whose every row was `…, 10, 'deep-concat-arrays',
// join(…), local, remoteReason` could transpose two arguments without a type error.
const fileSource = ({ provider, scope, surface, format, label, precedence, merge, file, writable, reason, candidates }: FileSourceSpec): AgentConfigSource =>
  ({ provider, scope, surface, format, label, precedence, merge, file, writable: writable && !!file, reason: file ? reason : 'No project or profile target is selected.', candidates })

/** Provider layers from low to high precedence. Environment/remote sources remain unknown. */
export function resolveAgentConfigSources(
  provider: AgentConfigProviderId,
  context: AgentConfigPathContext = {}
): AgentConfigSource[] {
  const local = localExecution(context)
  const remoteReason = local ? undefined : 'Remote config editing is unavailable until an SSH settings adapter is connected.'
  const home = context.home ?? homedir()
  const cwd = context.cwd
  const sources: AgentConfigSource[] = []

  if (provider === 'claude') {
    const profiled = context.profile === true
    sources.push(fileSource({ provider, scope: profiled ? 'profile' : 'user', surface: 'runtime', format: 'json', label: profiled ? 'Profile' : 'All projects', precedence: 10, merge: 'deep-concat-arrays', file: join(pointer(context, 'CLAUDE_CONFIG_DIR', '.claude'), 'settings.json'), writable: local, reason: remoteReason }))
    sources.push(fileSource({ provider, scope: 'project', surface: 'runtime', format: 'json', label: 'Project (shared)', precedence: 20, merge: 'deep-concat-arrays', file: projectFile(context, '.claude', 'settings.json'), writable: local, reason: remoteReason }))
    sources.push(fileSource({ provider, scope: 'local', surface: 'runtime', format: 'json', label: 'Project (private)', precedence: 30, merge: 'deep-concat-arrays', file: projectFile(context, '.claude', 'settings.local.json'), writable: local, reason: remoteReason }))
    sources.push(fileSource({ provider, scope: 'system-policy', surface: 'runtime', format: 'json', label: 'Managed policy', precedence: 50, merge: 'deep-concat-arrays', file: systemPath(context, provider, 'policy'), writable: false, reason: 'Managed policy is read-only in Workspace.' }))
    for (const [index, file] of claudeManagedDropIns(context).entries()) {
      sources.push(fileSource({ provider, scope: 'system-policy', surface: 'runtime', format: 'json', label: 'Managed policy drop-in', precedence: 51 + index, merge: 'deep-concat-arrays', file: file, writable: false, reason: 'Managed policy is read-only in Workspace.' }))
    }
  } else if (provider === 'codex') {
    sources.push(fileSource({ provider, scope: 'system-default', surface: 'runtime', format: 'toml', label: 'System defaults', precedence: 5, merge: 'deep', file: systemPath(context, provider, 'default'), writable: false, reason: 'System configuration is read-only in Workspace.' }))
    const codexHome = pointer(context, 'CODEX_HOME', '.codex')
    sources.push(fileSource({ provider, scope: context.profile ? 'profile' : 'user', surface: 'runtime', format: 'toml', label: context.profile ? 'Profile' : 'All projects', precedence: 10, merge: 'deep', file: join(codexHome, 'config.toml'), writable: local, reason: remoteReason }))
    sources.push(fileSource({ provider, scope: 'project', surface: 'runtime', format: 'toml', label: 'Project', precedence: 30, merge: 'deep', file: projectFile(context, '.codex', 'config.toml'), writable: local, reason: remoteReason }))
    sources.push({
      ...fileSource({ provider, scope: 'system-policy', surface: 'runtime', format: 'toml', label: 'Managed requirements', precedence: 50, merge: 'deep', file: systemPath(context, provider, 'policy'), writable: false, reason: 'Managed requirements constrain values and are read-only.' }),
      constraintOnly: true
    })
  } else if (provider === 'gemini') {
    sources.push(fileSource({ provider, scope: 'system-default', surface: 'runtime', format: 'jsonc', label: 'System defaults', precedence: 5, merge: 'deep-concat-arrays', file: systemPath(context, provider, 'default'), writable: false, reason: 'System defaults require administrator ownership.' }))
    const geminiHome = geminiConfigHome(context)
    sources.push(fileSource({ provider, scope: context.profile ? 'profile' : 'user', surface: 'runtime', format: 'jsonc', label: context.profile ? 'Profile' : 'All projects', precedence: 10, merge: 'deep-concat-arrays', file: join(geminiHome, 'settings.json'), writable: local, reason: remoteReason }))
    sources.push(fileSource({ provider, scope: 'project', surface: 'runtime', format: 'jsonc', label: 'Project', precedence: 20, merge: 'deep-concat-arrays', file: projectFile(context, '.gemini', 'settings.json'), writable: local, reason: remoteReason }))
    sources.push(fileSource({ provider, scope: 'system-policy', surface: 'runtime', format: 'jsonc', label: 'System overrides', precedence: 40, merge: 'deep-concat-arrays', file: systemPath(context, provider, 'policy'), writable: false, reason: 'System overrides require administrator ownership.' }))
  } else if (provider === 'aider') {
    sources.push(fileSource({ provider, scope: 'user', surface: 'runtime', format: 'yaml', label: 'All projects', precedence: 10, merge: 'replace', file: join(home, '.aider.conf.yml'), writable: local, reason: remoteReason }))
    const workingDirectory = cwd ? resolve(cwd) : undefined
    const repository = nearestGitRoot(workingDirectory)
    if (repository) sources.push(fileSource({ provider, scope: 'project', surface: 'runtime', format: 'yaml', label: 'Repository', precedence: 20, merge: 'replace', file: join(repository, '.aider.conf.yml'), writable: local, reason: remoteReason }))
    if (workingDirectory && workingDirectory !== repository) {
      sources.push(fileSource({ provider, scope: 'project', surface: 'runtime', format: 'yaml', label: 'Working directory', precedence: 30, merge: 'replace', file: join(workingDirectory, '.aider.conf.yml'), writable: local, reason: remoteReason }))
    }
  } else {
    const dir = join(configBase(context), 'opencode')
    for (const [index, name] of ['config.json', 'opencode.json', 'opencode.jsonc'].entries()) {
      sources.push(fileSource({ provider, scope: 'user', surface: 'runtime', format: 'jsonc', label: 'All projects', precedence: 10 + index, merge: 'deep', file: join(dir, name), writable: local, reason: remoteReason }))
    }
    for (const [index, name] of ['tui.json', 'tui.jsonc'].entries()) {
      sources.push(fileSource({ provider, scope: 'user', surface: 'tui', format: 'jsonc', label: 'TUI — all projects', precedence: 10 + index, merge: 'deep', file: join(dir, name), writable: local, reason: remoteReason }))
    }
    const customRuntime = context.env?.OPENCODE_CONFIG
    if (customRuntime) sources.push(fileSource({ provider, scope: 'user', surface: 'runtime', format: 'jsonc', label: 'Custom config override', precedence: 20, merge: 'deep', file: expandCustom(customRuntime, context), writable: local, reason: remoteReason }))
    const customTui = context.env?.OPENCODE_TUI_CONFIG
    if (customTui) sources.push(fileSource({ provider, scope: 'user', surface: 'tui', format: 'jsonc', label: 'Custom TUI override', precedence: 20, merge: 'deep', file: expandCustom(customTui, context), writable: local, reason: remoteReason }))
    let precedence = 30
    const projectDirs = traversalDirectories(cwd)
    for (const directory of projectDirs) {
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        sources.push(fileSource({ provider, scope: 'project', surface: 'runtime', format: 'jsonc', label: 'Project', precedence: precedence++, merge: 'deep', file: join(directory, name), writable: local, reason: remoteReason }))
      }
    }
    // The dedicated TUI loader currently calls ConfigPaths.files without a
    // worktree stop, unlike the runtime loader.
    const tuiProjectDirs = ancestorDirectories(cwd)
    for (const directory of tuiProjectDirs) {
      for (const name of ['tui.json', 'tui.jsonc']) {
        sources.push(fileSource({ provider, scope: 'project', surface: 'tui', format: 'jsonc', label: 'TUI — project', precedence: precedence++, merge: 'deep', file: join(directory, name), writable: local, reason: remoteReason }))
      }
    }
    // ConfigPaths.files applies project files root-to-CWD. ConfigPaths.directories
    // keeps discovered `.opencode` directories CWD-to-boundary, then appends
    // ~/.opencode and OPENCODE_CONFIG_DIR. Runtime stops at the worktree; the
    // dedicated TUI loader currently has no worktree stop.
    const homeConfigDir = join(home, '.opencode')
    const customConfigDir = context.env?.OPENCODE_CONFIG_DIR
      ? expandCustom(context.env.OPENCODE_CONFIG_DIR, context)
      : undefined
    const runtimeConfigDirs = [
      ...[...projectDirs].reverse()
        .map((directory) => join(directory, '.opencode'))
        .filter(existsSync),
      ...(existsSync(homeConfigDir) ? [homeConfigDir] : []),
      ...(customConfigDir ? [customConfigDir] : [])
    ]
    const seenRuntimeConfigDirs = new Set<string>()
    for (const directory of runtimeConfigDirs) {
      if (seenRuntimeConfigDirs.has(directory)) continue
      seenRuntimeConfigDirs.add(directory)
      const scope: AgentConfigScope = directory === homeConfigDir || directory === customConfigDir ? 'user' : 'project'
      for (const name of ['opencode.json', 'opencode.jsonc']) {
        sources.push(fileSource({ provider, scope: scope, surface: 'runtime', format: 'jsonc', label: scope === 'user' ? 'User config directory' : 'Project config directory', precedence: precedence++, merge: 'deep', file: join(directory, name), writable: local, reason: remoteReason }))
      }
    }
    const tuiConfigDirs = [
      ...[...tuiProjectDirs].reverse()
        .map((directory) => join(directory, '.opencode'))
        .filter(existsSync),
      ...(existsSync(homeConfigDir) ? [homeConfigDir] : []),
      ...(customConfigDir ? [customConfigDir] : [])
    ]
    const seenTuiConfigDirs = new Set<string>()
    for (const directory of tuiConfigDirs) {
      if (seenTuiConfigDirs.has(directory)) continue
      seenTuiConfigDirs.add(directory)
      const scope: AgentConfigScope = directory === homeConfigDir || directory === customConfigDir ? 'user' : 'project'
      for (const name of ['tui.json', 'tui.jsonc']) {
        sources.push(fileSource({ provider, scope: scope, surface: 'tui', format: 'jsonc', label: scope === 'user' ? 'TUI — user config directory' : 'TUI — project config directory', precedence: precedence++, merge: 'deep', file: join(directory, name), writable: local, reason: remoteReason }))
      }
    }
    if (context.env?.OPENCODE_CONFIG_CONTENT) {
      sources.push({
        provider,
        scope: 'user',
        surface: 'runtime',
        format: 'jsonc',
        label: 'Inline environment override',
        precedence: 50,
        merge: 'deep',
        writable: false,
        reason: 'Inline environment configuration is read-only in Workspace.',
        inlineText: context.env.OPENCODE_CONFIG_CONTENT
      })
    }
    const managed = systemPath(context, provider, 'policy')
    if (managed) {
      sources.push(fileSource({ provider, scope: 'system-policy', surface: 'runtime', format: 'jsonc', label: 'Managed policy', precedence: 60, merge: 'deep', file: managed, writable: false, reason: 'Managed configuration is read-only in Workspace.' }))
      sources.push(fileSource({ provider, scope: 'system-policy', surface: 'runtime', format: 'jsonc', label: 'Managed policy', precedence: 61, merge: 'deep', file: managed.replace(/\.json$/i, '.jsonc'), writable: false, reason: 'Managed configuration is read-only in Workspace.' }))
    }
  }

  // Session is a logical high-precedence source composed at launch. It has no
  // provider file and remote sessions stay read-only until every dialect can be
  // represented without a local generated path.
  sources.push({
    provider,
    scope: 'session',
    surface: 'runtime',
    format: provider === 'codex' ? 'toml' : provider === 'aider' ? 'yaml' : provider === 'claude' ? 'json' : 'jsonc',
    label: 'Next launch',
    precedence: provider === 'opencode' ? 55 : 45,
    merge: provider === 'aider' ? 'replace' : provider === 'codex' || provider === 'opencode' ? 'deep' : 'deep-concat-arrays',
    writable: local,
    reason: remoteReason
  })
  if (provider === 'opencode') {
    sources.push({
      provider,
      scope: 'session',
      surface: 'tui',
      format: 'jsonc',
      label: 'TUI — next launch',
      precedence: 55,
      merge: 'deep',
      writable: local,
      reason: remoteReason
    })
  }
  // Never inspect a local lookalike while presenting an SSH target. Until a
  // remote read adapter exists, the honest value is unknown and read-only.
  const executionSafe = local
    ? sources
    : sources.map((source) => ({ ...source, file: undefined, candidates: undefined, inlineText: undefined, writable: false, reason: remoteReason }))
  return executionSafe
    .map((source) => ({ ...source, file: source.candidates?.find(existsSync) ?? source.file }))
    .sort((a, b) => a.precedence - b.precedence)
}

export function selectAgentConfigSource(
  provider: AgentConfigProviderId,
  target: AgentConfigTarget,
  surface: AgentConfigSurface,
  context: AgentConfigPathContext = {},
  exists: (file: string) => boolean = existsSync
): AgentConfigSource | undefined {
  const sources = resolveAgentConfigSources(provider, { ...context, execution: target.execution, profile: target.scope === 'profile' || context.profile })
  const source = [...sources].reverse().find((item) => item.scope === target.scope && item.surface === surface)
  if (!source) return undefined
  const chosen = source.candidates?.find(exists) ?? source.file
  return { ...source, file: chosen }
}
