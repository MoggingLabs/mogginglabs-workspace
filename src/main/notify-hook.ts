import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  NOTIFY_HOOK_SOURCE,
  aiderBellEnv,
  codexBellArgs,
  geminiSystemSettings,
  opencodeConfig,
  opencodePluginSource,
  opencodeTuiConfig
} from '@backend/features/agents'

// App-wiring for the "always rings the bell" layer (backend/features/agents/
// notify-hook.ts): write the generated notify script + per-CLI config files into
// userData once per run, and hand every launch the session-scoped args/env its CLI
// needs to ring the pane — never a write to the user's own config files. Same
// lifecycle as the context relay next door. Claude's share of this rides its
// generated --settings file (src/main/context.ts).

let scriptPath: string | null = null

/** Write (idempotently) the generated notify script and return its absolute path —
 *  null on any filesystem failure (a launch must never break over the bell). */
export function notifyHookPath(): string | null {
  try {
    if (!scriptPath) {
      const dir = join(app.getPath('userData'), 'notify-hook')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'notify.mjs')
      writeFileSync(file, NOTIFY_HOOK_SOURCE)
      scriptPath = file
    }
    return scriptPath
  } catch {
    return null
  }
}

/** The shell invocation a CLI hook should run (`node "<script>"`). Double quotes
 *  parse the same in PowerShell, Git bash, and POSIX sh — the shells CLIs use for
 *  command hooks. Null when the script could not be written. */
export function notifyHookInvocation(): string | null {
  const p = notifyHookPath()
  return p ? `node "${p}"` : null
}

/** Read a JSON file that may not exist (or may be junk) — the merge bases below. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write a generated per-CLI config into userData/notify-hook, returning its path
 *  (null on failure — the launch proceeds without the bell, baseline still applies). */
function writeGenerated(name: string, content: string): string | null {
  try {
    const dir = join(app.getPath('userData'), 'notify-hook')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, content)
    return file
  } catch {
    return null
  }
}

/** Gemini's REAL system-settings path per platform — merged through so our override
 *  file never masks an admin's policy (see geminiSystemSettings). */
function geminiRealSystemSettingsPath(): string {
  if (process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json'
  if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json'
  return '/etc/gemini-cli/settings.json'
}

/** Session-scoped launch extras that make a provider ring its pane's bell: extra
 *  launch ARGS and/or env vars, per the CLI's own dialect. Claude is wired in
 *  claudeStatuslineArgs (context.ts); aider and codex additionally run the generated
 *  notify script, which is what lets their COMPLETION read as green instead of red.
*  Unknown/custom providers get nothing — the output-activity baseline still holds.
 *
 *  Every CLI here now speaks BOTH halves: an ambiguous "look at me" chime (which fires on
 *  completion as much as on a block) AND an explicit `done` that contradicts it, so the
 *  tracker's bell window can tell the two apart. Codex: OSC 9 + its notify program.
 *  Gemini: enableNotifications + the AfterAgent hook. OpenCode: its attention chime + a
 *  generated plugin. Aider has no chime at all — only a done — which is already honest. */
export function bellLaunchExtras(
  agentId: string,
  session: { runtime?: Record<string, unknown>; tui?: Record<string, unknown> } = {}
): { args: string[]; env: Record<string, string>; reason?: string } {
  const none = { args: [], env: {} }
  switch (agentId) {
    case 'codex':
      // Hand Codex the notify script too: its OSC 9 alone cannot tell turn-complete from
      // wants-approval, and the notify program (turn-complete ONLY) is what disambiguates.
      return { args: codexBellArgs(notifyHookPath() ?? undefined), env: {} }
    case 'gemini': {
      // The notification alone cannot say WHICH ("action-required prompts and session
      // completion" are one switch); the AfterAgent hook is the done that disambiguates it.
      const file = writeGenerated(
        'gemini-system-settings.json',
        geminiSystemSettings(
          readJson(geminiRealSystemSettingsPath()),
          notifyHookInvocation() ?? undefined,
          session.runtime
        )
      )
      return file ? { args: [], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file } } : none
    }
    case 'opencode': {
      const userTui = readJson(join(homedir(), '.config', 'opencode', 'tui.json'))
      const tui = writeGenerated('opencode-tui.json', opencodeTuiConfig(userTui, session.tui))
      if (!tui && Object.keys(session.tui ?? {}).length) return { ...none, reason: 'OpenCode next-launch TUI settings could not be materialized.' }
      if (!tui) return none
      const env: Record<string, string> = { OPENCODE_TUI_CONFIG: tui }
      // OpenCode has no hook config: its only verdict channel is a plugin. Both files must
      // land or we ship the chime alone — which is the ambiguous half, so the pane would
      // read every completion as attention.
      const script = notifyHookPath()
      const plugin = script ? writeGenerated('opencode-notify-plugin.mjs', opencodePluginSource(script)) : null
      let inherited: Record<string, unknown> = {}
      if (process.env.OPENCODE_CONFIG_CONTENT) {
        const errors: { error: number; offset: number; length: number }[] = []
        const parsed = parseJsonc(process.env.OPENCODE_CONFIG_CONTENT, errors, { allowTrailingComma: true, disallowComments: false })
        if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ...none, reason: 'OpenCode inline configuration is invalid and cannot be merged safely.' }
        }
        inherited = parsed as Record<string, unknown>
      }
      env.OPENCODE_CONFIG_CONTENT = opencodeConfig(plugin ?? undefined, session.runtime, inherited)
      return { args: [], env }
    }
    case 'aider': {
      const inv = notifyHookInvocation()
      return inv ? { args: [], env: aiderBellEnv(inv) } : none
    }
    default:
      return none
  }
}
