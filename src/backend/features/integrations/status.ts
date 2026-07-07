import type { McpApplyState, McpConnState } from '@contracts'
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
