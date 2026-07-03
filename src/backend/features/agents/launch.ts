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

/** Platform/shell-aware env-POINTER prefix (Phase-4/04 profiles). Values are already
 *  deny-listed at the persistence boundary — never secrets (ADR 0002). */
function envPrefix(env: Record<string, string> | undefined): string {
  if (!env) return ''
  const entries = Object.entries(env).filter(([k, v]) => k && typeof v === 'string')
  if (!entries.length) return ''
  if (process.platform === 'win32') {
    const shell = defaultShell().toLowerCase()
    if (shell.includes('powershell') || shell.includes('pwsh')) {
      return entries.map(([k, v]) => `$env:${k}="${v}"; `).join('')
    }
    return entries.map(([k, v]) => `set "${k}=${v}" && `).join('') // cmd.exe
  }
  // POSIX: `export`, not an assignment prefix — cmd's `set` and PowerShell's $env:
  // both persist the pointers in the pane session, so the POSIX pane must too
  // (cross-platform parity; an assignment prefix dies with the agent process,
  // which also broke usage-limit relaunches inheriting the pane state on Linux).
  return entries.map(([k, v]) => `export ${k}="${v}" && `).join('')
}

/**
 * Build the launch COMMAND for an agent CLI in a cwd. It's a command string only — the CLI
 * self-authenticates; NO credentials are ever built, stored, or injected (ADR 0002). `resume`
 * appends the adapter's resume flag; `env` (Phase-4/04) selects a PROFILE via pointer
 * variables. Returns null for an unknown agent id.
 */
export function buildLaunchCommand(
  agentId: string,
  cwd: string,
  resume = false,
  env?: Record<string, string>
): string | null {
  const adapter = findAdapter(agentId)
  if (!adapter) return null
  const base = resume && adapter.resumeFlag ? `${adapter.bin} ${adapter.resumeFlag}` : adapter.bin
  return cdPrefix(cwd) + envPrefix(env) + base
}
