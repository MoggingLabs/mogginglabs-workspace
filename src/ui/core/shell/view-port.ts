// Which top-level view fills the content region: the Home/launcher or the live grid.
// The workspace feature reveals 'grid' on user-initiated workspace activation; Home
// (and the rail's Home button) switches to 'home'. Pure pub/sub — no DOM here.

export type AppView = 'home' | 'grid'

type Listener = (view: AppView) => void

let current: AppView = 'home' // the app always opens on the launcher — never straight into a terminal
const listeners = new Set<Listener>()

export function activeView(): AppView {
  return current
}

export function setActiveView(view: AppView): void {
  if (view === current) return
  current = view
  for (const cb of listeners) cb(current)
}

/** Subscribe (replays the current view immediately). Returns unsubscribe. */
export function onViewChange(cb: Listener): () => void {
  listeners.add(cb)
  cb(current)
  return () => listeners.delete(cb)
}
