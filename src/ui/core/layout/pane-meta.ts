import type { PaneId } from '@contracts'

/**
 * Per-pane label (e.g. the launched agent's name). Set by `agents` on launch; rendered by each
 * `TerminalPane` as a corner badge (alongside its OSC state chip). A port so `agents` and
 * `terminal` stay decoupled.
 */
const labels = new Map<PaneId, string>()
const subscribers = new Set<(paneId: PaneId, label: string) => void>()

export function setPaneLabel(paneId: PaneId, label: string): void {
  labels.set(paneId, label)
  for (const cb of subscribers) cb(paneId, label)
}

export function getPaneLabel(paneId: PaneId): string | undefined {
  return labels.get(paneId)
}

export function onPaneLabel(cb: (paneId: PaneId, label: string) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
