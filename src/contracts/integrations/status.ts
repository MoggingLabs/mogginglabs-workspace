import type { HostedCliId } from './presets'

// MCP connection status (Phase-8/11). A continuously-known, PUSHED signal per
// (server × CLI): is each registered tool actually LIVE for each CLI. Read from
// the CLIs' OWN status output + our config hashes — never a token store, a
// vendor endpoint, or a TUI scrape (ADR 0002). States + counts are the whole
// vocabulary; no URL, tool name, or token detail ever rides an event (ADR 0005).

export type McpConnState =
  | 'off' // the CLI isn't installed
  | 'registered' // in the app, not written to this CLI's config
  | 'connected' // the CLI's own list reports it live
  | 'needs-auth' // the CLI's own list reports it wants authentication
  | 'error' // config says applied, but the CLI doesn't have it live
  | 'drift' // the managed block was edited/removed out of band

export interface McpConnStatus {
  serverId: string
  cli: HostedCliId
  state: McpConnState
  checkedAt: number
}

export const CONNECTED_STATES: readonly McpConnState[] = ['connected']
export const ATTENTION_STATES: readonly McpConnState[] = ['needs-auth', 'error']

/** The pushed snapshot — the whole per-(server×cli) grid + when it was taken. */
export interface McpStatusSnapshot {
  statuses: McpConnStatus[]
  at: number
}
