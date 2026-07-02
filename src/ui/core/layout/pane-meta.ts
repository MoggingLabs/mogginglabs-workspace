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

// ── Swarm role (Phase-4/01): named by the workspace feature from the template
// manifest; rendered by TerminalPane as a `.pane-role` chip. Same port pattern. ──
const roles = new Map<PaneId, string>()
const roleSubscribers = new Set<(paneId: PaneId, role: string) => void>()

export function setPaneRole(paneId: PaneId, role: string): void {
  roles.set(paneId, role)
  for (const cb of roleSubscribers) cb(paneId, role)
}

export function getPaneRole(paneId: PaneId): string | undefined {
  return roles.get(paneId)
}

export function onPaneRole(cb: (paneId: PaneId, role: string) => void): () => void {
  roleSubscribers.add(cb)
  return () => roleSubscribers.delete(cb)
}

// ── Remote pane (Phase-4/05): set by the workspace manifest BEFORE panes spawn, so
// TerminalPane can (a) spawn over ssh and (b) chip the host name. Host names are
// user data: chip + spawn only, never telemetry. ──
export interface PaneRemote {
  hostId: string
  name: string
}
const remotes = new Map<PaneId, PaneRemote>()

export function setPaneRemote(paneId: PaneId, remote: PaneRemote): void {
  remotes.set(paneId, remote)
}

export function getPaneRemote(paneId: PaneId): PaneRemote | undefined {
  return remotes.get(paneId)
}

export function clearPaneRemote(paneId: PaneId): void {
  remotes.delete(paneId)
}
