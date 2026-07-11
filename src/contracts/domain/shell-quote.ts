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
 * cmd         double quotes, spliced at every `%` (see cmdQuote). cmd has no escape
 *             INSIDE a quoted string, but `"` is an illegal character in a Windows
 *             filename, so a quoted path can never legitimately contain one. We strip
 *             any that appear anyway (such a path is malformed or hostile) rather than
 *             emit a string that would break out of the quotes.
 */
export function quotePathForShell(path: string, flavor: ShellFlavor): string {
  const clean = path.replace(CONTROL_CHARS, '')
  switch (flavor) {
    case 'posix':
      return `'${clean.replace(/'/g, `'\\''`)}'`
    case 'powershell':
      return `'${clean.replace(/'/g, `''`)}'`
    case 'cmd':
      return cmdQuote(clean)
  }
}

/**
 * cmd is the only dialect with no in-string escape, and two of its rules bite paths:
 *
 * 1. `%NAME%` expands EVEN INSIDE double quotes. Percent expansion is cmd's phase 1 —
 *    it runs before, and blind to, quoting, and a caret is literal inside quotes, so
 *    none of the usual escapes reach it. Measured against real cmd.exe with PATHX
 *    defined: `"C:\tmp\100%PATHX%end"` delivers `C:\tmp\100INJECTEDend` — a dropped
 *    filename silently retargets the user's next command at a DIFFERENT directory.
 *    That is the same threat this module already answers for control characters (a
 *    filename must not be able to forge input), so it gets the same treatment.
 *
 *    The fix is to break the pair, not to escape it: emit each `%` BETWEEN quoted runs
 *    rather than inside one. cmd's phase-1 scanner then looks for a variable literally
 *    named `"PATHX"`, quotes and all — a name no variable can have — so it expands
 *    nothing and leaves the text verbatim (at the prompt an unknown `%name%` is kept,
 *    not deleted). CommandLineToArgvW then strips the quotes and concatenates the
 *    adjacent runs, so the program receives the exact path as ONE argument:
 *      C:\tmp\100%PATHX%end  ->  "C:\tmp\100"%"PATHX"%"end"  ->  C:\tmp\100%PATHX%end
 *    Every literal character still sits inside quotes (the always-quoted contract holds;
 *    a space or `&` inside a spliced segment stays quoted and literal), and a path with
 *    no `%` — which is very nearly all of them — emits byte-identically to before.
 *
 * 2. A backslash RUN abutting a closing quote is an escape to every argv parser that
 *    follows CommandLineToArgvW/MSVCRT rules: `"C:\"` (a drive root) ends in `\"`, which
 *    reads as an escaped quote and glues the next token into the argument (measured: one
 *    argument, `C:\" SECOND`). Doubling the run fixes it — `"C:\\"` delivers `C:\`. This
 *    applies to EVERY quote we emit, including the ones the splice above introduces, or
 *    `C:\dir\%FOO%` would hand the parser a `\"` of its own making.
 */
function cmdQuote(clean: string): string {
  return clean
    .replace(/"/g, '')
    .split('%')
    .map((seg) => `"${seg.replace(/(\\+)$/, '$1$1')}"`)
    .join('%')
}

/** Join several dropped paths into one line of shell input, space-separated. */
export function quotePathsForShell(paths: readonly string[], flavor: ShellFlavor): string {
  return paths.map((p) => quotePathForShell(p, flavor)).join(' ')
}
