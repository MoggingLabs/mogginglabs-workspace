// Current-theme state over themes.ts: setTheme applies the tokens + terminal theme and
// notifies subscribers. Settings / the palette call setTheme; the workspace feature
// subscribes to persist the chosen id. Replays the current id on subscribe.
import { applyTheme, DEFAULT_THEME_ID } from './themes'

type Listener = (id: string) => void

let current = DEFAULT_THEME_ID
const listeners = new Set<Listener>()

export function currentThemeId(): string {
  return current
}

/** Apply + broadcast a theme choice. Returns the resolved (chosen) id. */
export function setTheme(id: string): string {
  current = applyTheme(id)
  for (const cb of listeners) cb(current)
  return current
}

export function onThemeChange(cb: Listener): () => void {
  listeners.add(cb)
  cb(current)
  return () => listeners.delete(cb)
}
