// Which top-level view owns the app below the titlebar (Phase-5/05): the Home
// launcher, the live grid, the Board, the Settings page, or the new-workspace
// wizard (8.5/02 — a full page, not a modal; it shares the rail with the grid so
// you can see the workspaces you already have while you configure the next one).
// The workspace feature reveals 'grid' on user-initiated workspace activation.
// Pure pub/sub — no DOM here.

import { getWorkspaces } from '../workspace/workspace-info-port'

export type AppView = 'home' | 'grid' | 'board' | 'settings' | 'wizard'

type Listener = (view: AppView) => void

let current: AppView = 'home' // the app always opens on the launcher — never straight into a terminal
let previous: AppView = 'home' // one step of history — enough for "leave Settings"
const listeners = new Set<Listener>()

export function activeView(): AppView {
  return current
}

export function setActiveView(view: AppView): void {
  // An empty grid is a dead end (blank canvas, no CTA) — with zero workspaces,
  // every road that would land there leads Home instead (audit UX-16).
  if (view === 'grid' && getWorkspaces().workspaces.length === 0) view = 'home'
  if (view === current) return
  previous = current
  current = view
  for (const cb of listeners) cb(current)
}

/** Return to the view the user came from (e.g. leaving Settings via Esc/back). */
export function goBack(): void {
  setActiveView(previous)
}

/** Subscribe (replays the current view immediately). Returns unsubscribe. */
export function onViewChange(cb: Listener): () => void {
  listeners.add(cb)
  cb(current)
  return () => listeners.delete(cb)
}
