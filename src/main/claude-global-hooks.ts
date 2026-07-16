import { join } from 'node:path'
import { ipcMain } from 'electron'
import { applyGlobalHooks, globalHooksState, removeGlobalHooks } from '@backend/features/agents'
import { resolveHome } from '@backend/features/usage'
import { AgentHookChannels, type GlobalHooksMutationResult, type GlobalHooksStatus } from '@contracts'
import { notifyHookInvocation } from './notify-hook'
import { ConcurrentConfigWriteError, changedUnderUs, ensureBackup, readIfExists, writeAtomic } from './mcp-manager'

// App wiring for the GLOBAL Claude alert hooks (backend/features/agents/global-hooks.ts —
// the hand-typed-launch gap). Same write discipline as every user-owned config this app
// touches (ADR 0008.b, the MCP manager's helpers reused verbatim): explicit user action
// only, a timestamped backup of the bytes being replaced, temp-file+rename, and a file that
// changed under us refuses rather than clobbers. The file is the DEFAULT Claude home's
// settings.json (CLAUDE_CONFIG_DIR honored) — the home a hand-typed `claude` reads; profile
// launches point at their own homes and keep the launch overlay's hooks regardless.

function settingsFile(): string {
  return join(resolveHome('claude', null), 'settings.json')
}

export function globalHooksStatus(): GlobalHooksStatus {
  const file = settingsFile()
  const invocation = notifyHookInvocation()
  if (!invocation) return { state: 'unreadable', file } // the script could not be written; nothing to point at
  try {
    return { state: globalHooksState(readIfExists(file), invocation), file }
  } catch {
    return { state: 'unreadable', file }
  }
}

function mutate(next: (current: string | null) => string | null): GlobalHooksMutationResult {
  const file = settingsFile()
  try {
    const current = readIfExists(file)
    const text = next(current)
    if (text === null) return { ok: true } // nothing of ours present — removal is already true
    if (changedUnderUs(file, current)) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
    const backup = ensureBackup(file, current)
    writeAtomic(file, text, current)
    return { ok: true, backup }
  } catch (e) {
    if (e instanceof ConcurrentConfigWriteError) {
      return { ok: false, reason: `${file} changed while we were preparing the write — nothing was written; try again` }
    }
    return { ok: false, reason: `could not update ${file}: ${String(e).slice(0, 160)}` }
  }
}

export function registerClaudeGlobalHooks(): void {
  ipcMain.handle(AgentHookChannels.status, (): GlobalHooksStatus => globalHooksStatus())
  ipcMain.handle(AgentHookChannels.apply, (): GlobalHooksMutationResult => {
    const invocation = notifyHookInvocation()
    if (!invocation) return { ok: false, reason: 'the notify script could not be written to userData — nothing to wire' }
    return mutate((current) => applyGlobalHooks(current, invocation))
  })
  ipcMain.handle(AgentHookChannels.remove, (): GlobalHooksMutationResult => mutate((current) => removeGlobalHooks(current)))
}
