import { defaultShell } from '../../platform/shell'
import { findAdapter } from './adapters'

// The built command is TYPED into an interactive shell pane, so quoting must survive
// each shell's expansion rules for interactive lines — double quotes do NOT: PowerShell
// expands `$` and backticks inside "…", cmd.exe expands %VAR% even inside quotes, and
// POSIX shells expand `$` and backticks inside "…". Single quotes are the literal form
// on PowerShell ('' doubles an embedded quote) and POSIX (the '\'' dance); cmd.exe has
// no literal quote at an interactive prompt at all — %DEFINED% expands inside "…" and
// %% doubling only works in batch files, so a cwd/value containing a defined var's
// %NAME% expands there. Accepted residual: paths with `%` are vanishingly rare, and an
// undefined %name% rides through cmd verbatim anyway.

/** PowerShell literal string: single quotes, embedded quotes doubled. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`
/** POSIX literal string: single quotes, embedded quotes via the '\'' dance. */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** Platform/shell-aware `cd` prefix so the agent starts in the workspace cwd. */
function cdPrefix(cwd: string, target: 'local' | 'posix'): string {
  if (!cwd) return ''
  if (target === 'local' && process.platform === 'win32') {
    const shell = defaultShell().toLowerCase()
    // -ErrorAction Stop makes a failed Set-Location abort the whole typed line (5.1-safe;
    // `&&` is pwsh-7-only) — parity with the `&&` gating below, so a vanished workspace
    // dir never launches the agent in whatever directory the pane happened to be in.
    if (shell.includes('powershell') || shell.includes('pwsh'))
      return `Set-Location ${psq(cwd)} -ErrorAction Stop; `
    return `cd /d "${cwd}" && ` // cmd.exe
  }
  return `cd ${shq(cwd)} && ` // bash/zsh
}

/** Platform/shell-aware env-POINTER prefix (Phase-4/04 profiles). Values are already
 *  deny-listed at the persistence boundary — never secrets (ADR 0002). PowerShell and
 *  POSIX values render single-quoted ALWAYS: it is the only form where `$`, backticks,
 *  and embedded double quotes (the bell layer's `node "<script>" --event done`) all
 *  arrive verbatim. cmd.exe stays `set "K=V"` — it strips only the OUTER quotes, inner
 *  ones ride through verbatim; %DEFINED% inside a value expands (see quoting note above). */
function envPrefix(env: Record<string, string> | undefined, target: 'local' | 'posix'): string {
  if (!env) return ''
  const entries = Object.entries(env).filter(([k, v]) => k && typeof v === 'string')
  if (!entries.length) return ''
  if (target === 'local' && process.platform === 'win32') {
    const shell = defaultShell().toLowerCase()
    if (shell.includes('powershell') || shell.includes('pwsh')) {
      return entries.map(([k, v]) => `$env:${k}=${psq(v)}; `).join('')
    }
    return entries.map(([k, v]) => `set "${k}=${v}" && `).join('') // cmd.exe
  }
  // POSIX: `export`, not an assignment prefix — cmd's `set` and PowerShell's $env:
  // both persist the pointers in the pane session, so the POSIX pane must too
  // (cross-platform parity; an assignment prefix dies with the agent process,
  // which also broke usage-limit relaunches inheriting the pane state on Linux).
  return entries.map(([k, v]) => `export ${k}=${shq(v)} && `).join('')
}

/** Quote one provider argument for the interactive shell that receives the line. */
function shellArg(value: string, target: 'local' | 'posix'): string {
  if (/^[A-Za-z0-9_./:\\=@,+\-\[\]]+$/.test(value)) return value
  if (target === 'posix') return shq(value)
  if (process.platform !== 'win32') return shq(value)
  const shell = defaultShell().toLowerCase()
  if (shell.includes('powershell') || shell.includes('pwsh')) return psq(value)
  // Standard Windows argv quoting. Percent/bang values emitted by session
  // codecs use TOML unicode escapes, so cmd expansion cannot change them.
  const escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/g, '$1$1')
  return `"${escaped}"`
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
  env?: Record<string, string>,
  mcpArgs?: string[],
  target: 'local' | 'posix' = 'local'
): string | null {
  const adapter = findAdapter(agentId)
  if (!adapter) return null
  const base = resume && adapter.resumeFlag ? `${adapter.bin} ${adapter.resumeFlag}` : adapter.bin
  // Tool-plan launch args (Phase-8/09): the CLI's mcp-config flag + path. Quote
  // args with spaces (userData paths on Windows); flags are literal.
  const flags = mcpArgs?.length
    ? ' ' + mcpArgs.map((arg) => shellArg(arg, target)).join(' ')
    : ''
  return cdPrefix(cwd, target) + envPrefix(env, target) + base + flags
}
