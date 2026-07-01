import type { PaneId } from '@contracts'

/**
 * The currently-focused pane + the cwd of its workspace. Published by the `workspace` feature
 * (from GridLayout focus + the active workspace's cwd); read by `agents` to launch a CLI into
 * "the focused pane at the right cwd". A port so neither feature imports the other.
 */
export interface FocusedPane {
  paneId: PaneId
  cwd: string
}

let current: FocusedPane | null = null
const subscribers = new Set<(f: FocusedPane | null) => void>()

export function setFocusedPane(focus: FocusedPane | null): void {
  current = focus
  for (const cb of subscribers) cb(current)
}

export function getFocusedPane(): FocusedPane | null {
  return current
}

export function onFocusedPane(cb: (f: FocusedPane | null) => void): () => void {
  subscribers.add(cb)
  cb(current)
  return () => subscribers.delete(cb)
}
