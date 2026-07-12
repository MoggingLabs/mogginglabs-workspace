/** The user's login shell, so their profile + PATH load (agent CLIs need it). */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

/** Force an interactive login shell on Unix so .zshrc/.bashrc are sourced. */
export function shellArgs(): string[] {
  return process.platform === 'win32' ? [] : ['-l']
}

/**
 * SHELL INTEGRATION (cwd reporting). Env a pane's shell is spawned with so it TELLS us where
 * it is — the cwd a pane reports is what per-pane git keys on, what a palette launch inherits,
 * and (since typed-launch detection) the directory a hand-typed agent's session log is named
 * for. bash/zsh setups commonly emit OSC 7 already; cmd.exe never does, so a Windows pane's
 * cwd was frozen at its seed forever — a `cd` inside the pane simply never reached the app.
 *
 * cmd.exe has one hook that fires on every prompt: %PROMPT%. Its `$e` is ESC and `$p` is the
 * current directory, so a cwd report can be prefixed to whatever prompt the user already has
 * (theirs is preserved verbatim, ours is invisible escape bytes). Both forms are emitted:
 * OSC 9;9 — the ConEmu/Windows-Terminal convention conhost is known to forward through ConPTY
 * — and standard OSC 7, so whichever survives the pipe lands. The parser accepts both and
 * de-dupes on value (agent-state/osc-parser.ts). This is the same mechanism Windows Terminal
 * and VS Code document for cmd.exe shell integration.
 *
 * POSIX gets nothing here on purpose: an injected PROMPT_COMMAND/PS1 would fight the user's
 * own prompt, and it isn't needed — a POSIX pane's agent cwd is read exactly from the process
 * itself (`/proc/<pid>/cwd`, `lsof`), which Windows cannot do without native code.
 */
export function shellIntegrationEnv(shell: string = defaultShell()): Record<string, string> {
  if (process.platform !== 'win32') return {}
  if (!/(^|[\\/])cmd(\.exe)?$/i.test(shell.trim())) return {} // PowerShell panes: %PROMPT% is not a thing
  const base = process.env.PROMPT || '$P$G' // cmd's own default when unset — never drop the user's
  return { PROMPT: '$e]9;9;$p$e\\$e]7;file:///$p$e\\' + base }
}
