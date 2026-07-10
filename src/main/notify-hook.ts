import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  NOTIFY_HOOK_SOURCE,
  aiderBellEnv,
  codexBellArgs,
  geminiSystemSettings,
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
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json'
  if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json'
  return '/etc/gemini-cli/settings.json'
}

/** Session-scoped launch extras that make a provider ring its pane's bell: extra
 *  launch ARGS and/or env vars, per the CLI's own dialect. Codex/Gemini/OpenCode
 *  notify via OSC 9/BEL on the PTY stream (the OscParser latches those); aider runs
 *  the generated notify script. Claude is wired in claudeStatuslineArgs (context.ts).
 *  Unknown/custom providers get nothing — the output-activity baseline still holds. */
export function bellLaunchExtras(agentId: string): { args: string[]; env: Record<string, string> } {
  const none = { args: [], env: {} }
  switch (agentId) {
    case 'codex':
      return { args: codexBellArgs(), env: {} }
    case 'gemini': {
      const file = writeGenerated('gemini-system-settings.json', geminiSystemSettings(readJson(geminiRealSystemSettingsPath())))
      return file ? { args: [], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file } } : none
    }
    case 'opencode': {
      const userTui = readJson(join(homedir(), '.config', 'opencode', 'tui.json'))
      const file = writeGenerated('opencode-tui.json', opencodeTuiConfig(userTui))
      return file ? { args: [], env: { OPENCODE_TUI_CONFIG: file } } : none
    }
    case 'aider': {
      const inv = notifyHookInvocation()
      return inv ? { args: [], env: aiderBellEnv(inv) } : none
    }
    default:
      return none
  }
}
