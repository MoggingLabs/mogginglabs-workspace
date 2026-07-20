// The MCP server registry shapes (Phase-8/06, ADR 0008.b/d). A registered
// server is CONFIG the app writes into the CLIs' own files — the app never
// runs, proxies, or authenticates one. Env values are `${VAR}` REFERENCES
// only (0008.d pointers): a secret-shaped literal is refused at save.

import type { HostedCliId, McpTransport } from './presets'

/** One registry row. `builtIn` marks the house server (always first, not
 *  editable/removable — one entry, whole app). */
export interface McpServerEntry {
  /** Config-key slug: [a-z0-9_-], ≤ 48 chars — it names the entry in every
   *  dialect (`mcpServers.<id>` / `[mcp_servers.<id>]`). */
  id: string
  label: string
  transport: McpTransport
  /** stdio: the launch command + args (paths, never secrets). */
  command?: string
  args?: readonly string[]
  /** http: the remote server url (https; plain http only for loopback). */
  url?: string
  /** Env REFERENCES the CLI resolves at ITS runtime — stored rows must be exactly
   *  `${VAR}` and literals are refused. (The built-in house row used to be the one
   *  literal exception, for `ELECTRON_RUN_AS_NODE=1`; since the runtime split it is a
   *  bare command on the standalone helper and carries no env at all — ADR 0017.) */
  env?: Readonly<Record<string, string>>
  /** http auth headers (8/07): values are `${VAR}` or `Scheme ${VAR}` — the
   *  reference rule again; a literal token is refused at save. */
  headers?: Readonly<Record<string, string>>
  builtIn?: boolean
}

/** The marker every managed config entry carries (the dialect's comment
 *  equivalent in TOML) — writers touch ONLY blocks wearing it. */
export const MCP_MANAGED_BY = 'mogginglabs'

/**
 * How a server row names its transport TO A READER. `http` is the MCP streamable-HTTP
 * transport keyword — but shown bare next to a server name ("vercel · http") it reads
 * as an insecure URL scheme, which is precisely the confusion it caused. Remote servers
 * are always reached over https (validated at save; plain http is allowed only to
 * loopback), so the honest, unambiguous thing to show is the endpoint's real scheme —
 * the security fact a reader is actually looking for in that slot — not the wire-format
 * keyword. `stdio` is a local subprocess and reads as no scheme at all, so it stands.
 */
export function transportLabel(entry: Pick<McpServerEntry, 'transport' | 'url'>): string {
  if (entry.transport === 'stdio') return 'stdio'
  try {
    if (entry.url) return new URL(entry.url).protocol === 'https:' ? 'HTTPS' : 'HTTP · localhost'
  } catch {
    /* malformed url — fall through to the bare transport */
  }
  return 'HTTP'
}

/** Per-(server × CLI) apply state the manager surfaces. Drift is DETECTED,
 *  never auto-healed: re-apply/adopt/forget are explicit user verbs. */
export type McpApplyState = 'not-applied' | 'applied' | 'drift-edited' | 'drift-missing'

export interface McpCliStatus {
  cli: HostedCliId
  installed: boolean
  /** The resolved target config file (per-OS path table + pointer homes). */
  file: string
  state: McpApplyState
}
