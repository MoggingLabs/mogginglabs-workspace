import { defaultShell } from '../../platform/shell'
import { findAdapter } from './adapters'

/** Platform/shell-aware `cd` prefix so the agent starts in the workspace cwd. */
function cdPrefix(cwd: string): string {
  if (!cwd) return ''
  if (process.platform === 'win32') {
    const shell = defaultShell().toLowerCase()
    if (shell.includes('powershell') || shell.includes('pwsh')) return `Set-Location "${cwd}"; `
    return `cd /d "${cwd}" && ` // cmd.exe
  }
  return `cd "${cwd}" && ` // bash/zsh
}

/**
 * Build the launch COMMAND for an agent CLI in a cwd. It's a command string only — the CLI
 * self-authenticates; NO credentials are ever built, stored, or injected (ADR 0002). `resume`
 * appends the adapter's resume flag. Returns null for an unknown agent id.
 */
export function buildLaunchCommand(agentId: string, cwd: string, resume = false): string | null {
  const adapter = findAdapter(agentId)
  if (!adapter) return null
  const base = resume && adapter.resumeFlag ? `${adapter.bin} ${adapter.resumeFlag}` : adapter.bin
  return cdPrefix(cwd) + base
}
