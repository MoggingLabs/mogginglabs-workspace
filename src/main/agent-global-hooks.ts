import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import {
  applyCodexGlobal,
  applyGeminiGlobal,
  applyGlobalHooks,
  applyOpencodePlugin,
  applyOpencodeTui,
  codexGlobalState,
  geminiGlobalState,
  globalHooksState,
  isWiringConflict,
  opencodeGlobalState,
  removeCodexGlobal,
  removeGeminiGlobal,
  removeGlobalHooks,
  removeOpencodePlugin,
  removeOpencodeTui,
  type GeminiWiringMemo,
  type OpencodeTuiMemo
} from '@backend/features/agents'
import { resolveHome } from '@backend/features/usage'
import {
  AgentHookChannels,
  type GlobalHookProvider,
  type GlobalHooksMutationResult,
  type GlobalHooksProviderStatus,
  type GlobalHooksStatus
} from '@contracts'
import { notifyHookInvocation, notifyHookPath, opencodeNotifyPluginPath } from './notify-hook'
import { ConcurrentConfigWriteError, changedUnderUs, ensureBackup, readIfExists, writeAtomic } from './mcp-manager'
import { getSettingsStore } from './app-settings'

// App wiring for the GLOBAL agent alert hooks (backend/features/agents/global-hooks.ts —
// the hand-typed-launch gap, all four CLIs). Same write discipline as every user-owned
// config this app touches (ADR 0008.b, the MCP manager's helpers reused verbatim): a
// timestamped backup of the bytes being replaced, temp-file+rename, a file that changed
// under us refuses rather than clobbers, and a CONFLICT (the user's own codex `notify`, a
// differing tui value) refuses with its reason on display.
//
// ONE deliberate exception to "explicit user action only": typed-launch detection AUTO-wires
// a provider whose alerts are absent (agents feature, autoWireGlobalHooks). The ask-toast it
// replaces was shown once per app run and demonstrably never converted — found live
// 2026-07-18: eight hand-typed claude panes running all afternoon, every status dot
// verdict-mute, the nudge long expired. The writes stay additive-and-backed-up, conflicts
// still refuse (a user's own notify config is their machine), and a successful REMOVE is
// remembered as an opt-out that detection never overrides. The booleans
// that cannot carry an ours-marker (gemini's enableNotifications, opencode's attention pair)
// ride a KV memo, so Remove restores what Apply displaced instead of guessing.
//
// Targets are the DEFAULT homes (pointer envs honored via resolveHome / XDG) — the homes a
// hand-typed launch reads; profile launches point at their own homes and keep the launch's
// session-scoped config regardless.

const MEMO_KEY = (provider: string): string => `agenthooks.memo.${provider}`

/** Detection-time auto-wiring's one brake: a user who REMOVED a provider's wiring said no.
 *  Recorded on every successful remove, cleared by an explicit apply — so the auto-wire in
 *  the agents feature (typed-launch detection) never re-applies what a human took out. */
const OPTOUT_KEY = (provider: string): string => `agenthooks.autowire.${provider}`

function autoWireAllowed(provider: string): boolean {
  try {
    return getSettingsStore()?.getSetting(OPTOUT_KEY(provider)) !== 'off'
  } catch {
    return true
  }
}
function autoWireRecord(provider: string, allowed: boolean): void {
  try {
    getSettingsStore()?.setSetting(OPTOUT_KEY(provider), allowed ? '' : 'off')
  } catch {
    /* a lost opt-out re-nudges at worst; the remove itself already succeeded */
  }
}

function memoRead<T>(provider: string): T | null {
  try {
    const raw = getSettingsStore()?.getSetting(MEMO_KEY(provider))
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function memoWrite(provider: string, memo: unknown): void {
  try {
    getSettingsStore()?.setSetting(MEMO_KEY(provider), memo === null ? '' : JSON.stringify(memo))
  } catch {
    /* a lost memo degrades Remove to leave-alone, never to a wrong write */
  }
}

const claudeFile = (): string => join(resolveHome('claude', null), 'settings.json')
const codexFile = (): string => join(resolveHome('codex', null), 'config.toml')
const geminiFile = (): string => join(resolveHome('gemini', null), 'settings.json')
/** OpenCode's CONFIG dir (not its XDG data home): $XDG_CONFIG_HOME/opencode or ~/.config/opencode
 *  — the same resolution bellLaunchExtras mirrors for tui.json. */
const opencodeDir = (): string =>
  process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : join(homedir(), '.config', 'opencode')

export const GLOBAL_HOOK_PROVIDERS: readonly GlobalHookProvider[] = ['claude', 'codex', 'gemini', 'opencode']

export function globalHooksStatusAll(): GlobalHooksStatus {
  const invocation = notifyHookInvocation()
  const script = notifyHookPath()
  const rows: GlobalHooksProviderStatus[] = []
  const push = (provider: GlobalHookProvider, files: string[], read: () => { state: GlobalHooksProviderStatus['state']; reason?: string }): void => {
    if (!invocation || !script) {
      rows.push({ provider, files, state: 'unreadable', reason: 'the notify script could not be written to userData' })
      return
    }
    try {
      rows.push({ provider, files, autoWire: autoWireAllowed(provider), ...read() })
    } catch (e) {
      rows.push({ provider, files, autoWire: autoWireAllowed(provider), state: 'unreadable', reason: String((e as Error).message).slice(0, 200) })
    }
  }
  push('claude', [claudeFile()], () => ({ state: globalHooksState(readIfExists(claudeFile()), invocation!) }))
  push('codex', [codexFile()], () => codexGlobalState(readIfExists(codexFile()), script!))
  push('gemini', [geminiFile()], () => geminiGlobalState(readIfExists(geminiFile()), invocation!))
  push('opencode', [join(opencodeDir(), 'tui.json'), join(opencodeDir(), 'opencode.json')], () => {
    const plugin = opencodeNotifyPluginPath()
    if (!plugin) return { state: 'unreadable' as const, reason: 'the notify plugin could not be written to userData' }
    return opencodeGlobalState(readIfExists(join(opencodeDir(), 'tui.json')), readIfExists(join(opencodeDir(), 'opencode.json')), plugin)
  })
  return rows
}

/** One guarded rewrite: read -> derive -> refuse-if-changed -> backup -> atomic write.
 *  `null` from derive = nothing to write (already true). Returns the backup, if one. */
function rewrite(file: string, derive: (current: string | null) => string | null, backups: string[]): void {
  const current = readIfExists(file)
  const text = derive(current)
  if (text === null) return
  if (changedUnderUs(file, current)) {
    throw new ConcurrentConfigWriteError()
  }
  const backup = ensureBackup(file, current)
  writeAtomic(file, text, current)
  if (backup) backups.push(backup)
}

function mutateProvider(provider: GlobalHookProvider, action: 'apply' | 'remove'): GlobalHooksMutationResult {
  const invocation = notifyHookInvocation()
  const script = notifyHookPath()
  if (!invocation || !script) return { ok: false, reason: 'the notify script could not be written to userData — nothing to wire' }
  const backups: string[] = []
  let file = ''
  try {
    if (provider === 'claude') {
      file = claudeFile()
      rewrite(file, (current) => (action === 'apply' ? applyGlobalHooks(current, invocation) : removeGlobalHooks(current)), backups)
    } else if (provider === 'codex') {
      file = codexFile()
      rewrite(file, (current) => (action === 'apply' ? applyCodexGlobal(current, script) : removeCodexGlobal(current)), backups)
    } else if (provider === 'gemini') {
      file = geminiFile()
      if (action === 'apply') {
        let memo: GeminiWiringMemo | null = null
        rewrite(file, (current) => {
          const out = applyGeminiGlobal(current, invocation)
          memo = out.memo
          return out.text
        }, backups)
        if (memo) memoWrite('gemini', memo)
      } else {
        rewrite(file, (current) => removeGeminiGlobal(current, memoRead<GeminiWiringMemo>('gemini')), backups)
        memoWrite('gemini', null)
      }
    } else if (provider === 'opencode') {
      const plugin = opencodeNotifyPluginPath()
      if (!plugin) return { ok: false, reason: 'the notify plugin could not be written to userData — nothing to wire' }
      const tui = join(opencodeDir(), 'tui.json')
      const config = join(opencodeDir(), 'opencode.json')
      if (action === 'apply') {
        let memo: OpencodeTuiMemo | null = null
        file = tui
        rewrite(tui, (current) => {
          const out = applyOpencodeTui(current)
          memo = out.memo
          return out.text
        }, backups)
        if (memo) memoWrite('opencode', memo)
        file = config
        rewrite(config, (current) => applyOpencodePlugin(current, plugin), backups)
      } else {
        file = config
        rewrite(config, (current) => removeOpencodePlugin(current), backups)
        file = tui
        rewrite(tui, (current) => removeOpencodeTui(current, memoRead<OpencodeTuiMemo>('opencode')), backups)
        memoWrite('opencode', null)
      }
    } else {
      return { ok: false, reason: `unknown provider: ${String(provider)}` }
    }
    return { ok: true, ...(backups.length ? { backups } : {}) }
  } catch (e) {
    if (e instanceof ConcurrentConfigWriteError) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
    if (isWiringConflict(e)) return { ok: false, reason: String((e as Error).message) }
    return { ok: false, reason: `could not update ${file}: ${String(e).slice(0, 160)}` }
  }
}

const asProvider = (payload: unknown): GlobalHookProvider | null => {
  const provider = (payload as { provider?: unknown } | null)?.provider
  return GLOBAL_HOOK_PROVIDERS.includes(provider as GlobalHookProvider) ? (provider as GlobalHookProvider) : null
}

export function registerAgentGlobalHooks(): void {
  ipcMain.handle(AgentHookChannels.status, (): GlobalHooksStatus => globalHooksStatusAll())
  ipcMain.handle(AgentHookChannels.apply, (_e, payload: unknown): GlobalHooksMutationResult => {
    const provider = asProvider(payload)
    if (!provider) return { ok: false, reason: 'unknown provider' }
    const result = mutateProvider(provider, 'apply')
    // Any apply — the user's own, or detection's auto-wire — re-arms auto-wiring: whoever
    // wired it clearly wants the alerts, so a later stale state may self-heal again.
    if (result.ok) autoWireRecord(provider, true)
    return result
  })
  ipcMain.handle(AgentHookChannels.remove, (_e, payload: unknown): GlobalHooksMutationResult => {
    const provider = asProvider(payload)
    if (!provider) return { ok: false, reason: 'unknown provider' }
    const result = mutateProvider(provider, 'remove')
    // A successful remove is the user saying no — remember it, or the next detected
    // typed session would silently write back what they just deleted.
    if (result.ok) autoWireRecord(provider, false)
    return result
  })
}
