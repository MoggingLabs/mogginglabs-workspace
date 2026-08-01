import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

/**
 * SPAWNING A TOOL THAT MIGHT BE A WINDOWS BATCH SHIM.
 *
 * Node has refused to `spawn` a `.cmd`/`.bat` file directly since the CVE-2024-27980 fix
 * (18.20.2 / 20.12.2 / 21.7.3): it throws `EINVAL` before the process is created. The CVE
 * was real — `cmd.exe` re-parses its command line, so an argument carrying `&` or `|` could
 * inject a second command — and the fix was to stop pretending a batch file is an
 * executable. It is not; it is a script that only `cmd.exe` can run.
 *
 * On Windows that lands squarely on this app: `npm` is `npm.cmd`, and so is every CLI npm
 * installs — `claude.cmd`, `codex.cmd`, `gemini.cmd`. A naive `spawn` fails on all of them
 * with a five-letter error and no explanation. (Measured: one-click setup died on
 * `spawn EINVAL` running `C:\Program Files\nodejs\npm.CMD config set prefix …`.)
 *
 * So we do explicitly, and visibly, what `shell: true` does implicitly: build the command
 * line ourselves and hand it to `cmd.exe /d /s /c` with verbatim arguments. The injection
 * surface the CVE describes is closed here by construction rather than by hope —
 * `quoteForCmd` REFUSES a value carrying a character `cmd.exe` would re-interpret outside
 * quotes, and every caller's argv is program-supplied (a package name from our own
 * registry, a path we resolved), never user text.
 */

/** `cmd.exe` metacharacters, plus whitespace: anything here forces quoting. */
const NEEDS_QUOTES = /[\s&|<>^()!%,;=]/

/**
 * Quote one argument for a `cmd.exe /s /c "<line>"` command line.
 *
 * A double quote inside the value cannot be represented safely under
 * `windowsVerbatimArguments` (the outer `/s` quoting rule and CreateProcess's own argv
 * parser disagree about how to unescape it), so it is refused rather than mangled. No
 * caller supplies one — this is the guard that keeps that true.
 */
export function quoteForCmd(value: string): string {
  if (value.includes('"')) throw new Error(`cannot spawn: argument contains a double quote (${value})`)
  return NEEDS_QUOTES.test(value) ? `"${value}"` : value
}

/** Is this a script only `cmd.exe` can execute? */
export function isWindowsBatch(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
}

/**
 * The (file, args) pair to hand `child_process` for a tool that may be a batch shim.
 * Pure, so the wrapping is testable without spawning anything.
 */
export function spawnPlan(file: string, args: readonly string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!isWindowsBatch(file)) return { file, args: [...args], verbatim: false }
  // Exactly what Node's own `shell: true` builds on Windows — `/d` skips AutoRun commands
  // (a user's registry-installed cmd hook must not run inside our install), `/s` makes the
  // outer quote pair strip cleanly, `/c` runs and exits.
  const line = [file, ...args].map(quoteForCmd).join(' ')
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/** `spawn`, but a Windows batch shim actually runs instead of throwing EINVAL. */
export function spawnTool(file: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const plan = spawnPlan(file, args)
  return spawn(plan.file, plan.args, plan.verbatim ? { ...options, windowsVerbatimArguments: true } : options)
}
