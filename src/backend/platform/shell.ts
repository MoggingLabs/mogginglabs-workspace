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
