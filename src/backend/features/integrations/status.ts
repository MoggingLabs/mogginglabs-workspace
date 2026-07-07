import type { McpApplyState, McpConnState, McpConnStatus } from '@contracts'
import type { CliServerState } from './catalog'

// The connection-state derivation (Phase-8/11), pure over what we already read:
// our config apply/drift verdict (06) + the CLI's OWN list output parsed to a
// per-server state (07's parseCliMcpList). No new source of truth, no probing.

/** Compose the per-(server×cli) connection state, cheapest signal first. */
export function deriveConnState(
  installed: boolean,
  applyState: McpApplyState,
  cliList: CliServerState | 'unknown'
): McpConnState {
  if (!installed) return 'off'
  if (applyState === 'not-applied') return 'registered'
  if (applyState === 'drift-edited' || applyState === 'drift-missing') return 'drift'
  // applied — the CLI's own list is the live truth.
  if (cliList === 'connected' || cliList === 'listed') return 'connected'
  if (cliList === 'needs-auth') return 'needs-auth'
  return 'error' // applied in config but the CLI doesn't list it live
}

/** The failure shoulder-tap logic (8/13): a `connected -> needs-auth` TRANSITION
 *  earns ONE nag; a `-> connected` re-arms it (a new token epoch). Pure over two
 *  snapshots so the single-fire discipline (7/09) is testable without a poller. */
export function detectAuthNags(
  prev: readonly McpConnStatus[],
  next: readonly McpConnStatus[]
): { nags: { serverId: string; cli: string }[]; repairs: { serverId: string; cli: string }[] } {
  const prevState = new Map(prev.map((s) => [`${s.serverId}:${s.cli}`, s.state]))
  const nags: { serverId: string; cli: string }[] = []
  const repairs: { serverId: string; cli: string }[] = []
  for (const s of next) {
    const p = prevState.get(`${s.serverId}:${s.cli}`)
    if (s.state === 'needs-auth' && p === 'connected') nags.push({ serverId: s.serverId, cli: s.cli })
    else if (s.state === 'connected' && (p === 'needs-auth' || p === 'error')) repairs.push({ serverId: s.serverId, cli: s.cli })
  }
  return { nags, repairs }
}
