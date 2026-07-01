import type { ITheme } from '@xterm/xterm'

/**
 * Broadcasts the active xterm terminal theme to every `TerminalPane` without coupling the
 * `workspace` feature (which owns the theme picker) to `terminal`. Panes subscribe and apply;
 * the workspace feature calls `setTerminalTheme`. Latest value is replayed to new subscribers,
 * so a pane mounted after a theme change still gets the current theme.
 */
let current: ITheme | null = null
const subscribers = new Set<(theme: ITheme) => void>()

export function setTerminalTheme(theme: ITheme): void {
  current = theme
  for (const cb of subscribers) cb(theme)
}

export function onTerminalTheme(cb: (theme: ITheme) => void): () => void {
  subscribers.add(cb)
  if (current) cb(current)
  return () => subscribers.delete(cb)
}
