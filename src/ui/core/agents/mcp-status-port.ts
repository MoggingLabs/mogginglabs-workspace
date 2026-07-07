import type { HostedCliId, McpStatusSnapshot } from '@contracts'

// Propagates MCP connection status to the terminal (Phase-8/11). The settings
// feature pushes the latest snapshot here; each pane records its CLI (and the
// connected-server count it launched with) so TerminalPane can render a quiet
// chip: connected count, an attention flip on needs-auth/error, and a
// "restart to pick up {n} new tools" nudge when servers connected AFTER the
// pane's launch (MCP configs are read at CLI launch). States + counts only.

let snapshot: McpStatusSnapshot = { statuses: [], at: 0 }
const paneCli = new Map<number, HostedCliId>()
const paneLaunchConnected = new Map<number, number>() // connected count for the pane's CLI at launch
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}

const connectedFor = (cli: HostedCliId): number => snapshot.statuses.filter((s) => s.cli === cli && s.state === 'connected').length
const attentionFor = (cli: HostedCliId): boolean => snapshot.statuses.some((s) => s.cli === cli && (s.state === 'needs-auth' || s.state === 'error'))

export function setMcpSnapshot(next: McpStatusSnapshot): void {
  snapshot = next
  emit()
}

export function recordPaneCli(paneId: number, cli: HostedCliId): void {
  paneCli.set(paneId, cli)
  paneLaunchConnected.set(paneId, connectedFor(cli))
  emit()
}

export function clearPaneCli(paneId: number): void {
  paneCli.delete(paneId)
  paneLaunchConnected.delete(paneId)
}

export interface PaneMcpChip {
  connected: number
  attention: boolean
  /** New servers connected since this pane launched — a restart picks them up. */
  restartNew: number
}

export function mcpChipForPane(paneId: number): PaneMcpChip | null {
  const cli = paneCli.get(paneId)
  if (!cli) return null
  const connected = connectedFor(cli)
  const launchN = paneLaunchConnected.get(paneId) ?? connected
  return { connected, attention: attentionFor(cli), restartNew: Math.max(0, connected - launchN) }
}

export function onMcpStatusChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
