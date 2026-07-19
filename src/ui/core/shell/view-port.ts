// Which top-level view owns the app below the titlebar (Phase-5/05): the Home
// launcher, the live grid, the Board, the Settings page, the new-workspace
// wizard (8.5/02 — a full page, not a modal; it shares the rail with the grid so
// you can see the workspaces you already have while you configure the next one),
// or the Brain (ADR 0018/10 — the workspace index made visible).
// The workspace feature reveals 'grid' on user-initiated workspace activation.
// Pure pub/sub — no DOM here.

import { getWorkspaces } from '../workspace/workspace-info-port'

export type AppView = 'home' | 'grid' | 'board' | 'settings' | 'wizard' | 'brain'

type Listener = (view: AppView) => void

let current: AppView = 'home' // the app always opens on the launcher — never straight into a terminal
let previous: AppView = 'home' // one step of history — enough for "leave Settings"
const listeners = new Set<Listener>()

export function activeView(): AppView {
  return current
}

/**
 * Home and the grid are the two halves of one invariant: **exactly one of them can be
 * right, and the workspace count decides which.** Home is the launcher you see at boot
 * and the empty state you fall back to; it is not a place to visit. So there is no way
 * back to it while a workspace exists — no button, no shortcut, no command (they were
 * all removed) — and this guard closes the remaining roads: `goBack()` out of Settings,
 * a stale `previous`, any future caller. Delete your last workspace and Home returns.
 *
 * `current` starts at 'home' as a literal, not through this function, because at boot the
 * workspace list has not loaded yet and there is nothing else to show. That is the ONLY
 * moment Home appears with workspaces in existence, and it lasts exactly as long as the
 * state read: workspace/index.ts's restore() reveals the grid the moment it finds one.
 */
export function setActiveView(view: AppView): void {
  const hasWorkspaces = getWorkspaces().workspaces.length > 0
  // An empty grid is a dead end (blank canvas, no CTA) — with zero workspaces,
  // every road that would land there leads Home instead (audit UX-16).
  if (view === 'grid' && !hasWorkspaces) view = 'home'
  // ...and the converse: with workspaces, Home is unreachable — the grid owns the app.
  if (view === 'home' && hasWorkspaces) view = 'grid'
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
