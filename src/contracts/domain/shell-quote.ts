// Quoting a filesystem path so a shell (or an agent CLI reading a line of text)
// receives it as ONE argument. Pure and platform-free on purpose: the renderer
// drops files, the main process names the flavor, and this decides the syntax —
// so the rule is testable without a PTY.

/** Which quoting dialect the pane's shell speaks. */
export type ShellFlavor = 'posix' | 'cmd' | 'powershell'

/** The flavor implied by a shell's executable path. `defaultShell()` on Windows
 *  resolves COMSPEC first, which is `cmd.exe` on a stock install — so cmd, NOT
 *  PowerShell, is the Windows default. Anything else on win32 is treated as
 *  PowerShell only when it actually looks like one. */
export function shellFlavor(shellPath: string, platform: string): ShellFlavor {
  if (platform !== 'win32') return 'posix'
  const exe = shellPath.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? ''
  if (exe.startsWith('pwsh') || exe.startsWith('powershell')) return 'powershell'
  return 'cmd'
}


/** Characters that cannot occur in a real path, and which would let a dropped
 *  filename forge a newline — i.e. "press Enter" — once written into the PTY. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/**
 * Quote `path` for `flavor`. Always returns a single shell word, ALWAYS quoted —
 * the product contract ("the complete path, inside quotes"), not merely an escape
 * rule. An earlier revision returned safe-looking paths bare, and the first thing a
 * real user noticed was the missing quotes. An unconditional rule also cannot be
 * wrong the way a safe-list heuristic can (one missed character from splitting an
 * argument).
 *
 * posix       single quotes; an embedded ' closes, escapes, and reopens ('\'').
 *             Single quotes suppress $, `, \, ! and glob chars outright.
 * powershell  single quotes; an embedded ' is doubled (''). Single-quoted
 *             PowerShell strings do NOT interpolate $ or backtick, so a path
 *             like `C:\$Recycle.Bin` survives — double quotes would not.
 * cmd         double quotes. cmd has no escape INSIDE a quoted string, but `"`
 *             is an illegal character in a Windows filename, so a quoted path
 *             can never legitimately contain one. We strip any that appear
 *             anyway (such a path is malformed or hostile) rather than emit a
 *             string that would break out of the quotes.
 */
export function quotePathForShell(path: string, flavor: ShellFlavor): string {
  const clean = path.replace(CONTROL_CHARS, '')
  switch (flavor) {
    case 'posix':
      return `'${clean.replace(/'/g, `'\\''`)}'`
    case 'powershell':
      return `'${clean.replace(/'/g, `''`)}'`
    case 'cmd':
      return `"${clean.replace(/"/g, '')}"`
  }
}

/** Join several dropped paths into one line of shell input, space-separated. */
export function quotePathsForShell(paths: readonly string[], flavor: ShellFlavor): string {
  return paths.map((p) => quotePathForShell(p, flavor)).join(' ')
}
