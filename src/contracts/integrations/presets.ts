// Integrations Catalog preset shapes (Phase-8/01; 07 ships the rows). A preset
// is a DATA ROW describing an OFFICIAL third-party MCP server the manager (06)
// can register across the hosted CLIs — we never run, proxy, or authenticate
// one (ADR 0008.b/d). Keys are pointers: env-refs or vault slots, never
// literals (the writers refuse secret-shaped values, presets included).

/** The hosted CLIs the manager writes config for (the hooks/ dialects). */
export const HOSTED_CLIS = ['claude-code', 'codex', 'gemini'] as const
export type HostedCliId = (typeof HOSTED_CLIS)[number]

/** MCP transports the catalog carries: stdio commands and remote
 *  streamable-HTTP servers (research §2 — all three CLIs speak both). */
export type McpTransport = 'stdio' | 'http'

/** How a server authenticates, vendor-preferred first: `oauth` = the CLI's
 *  own MCP-OAuth (per-CLI consent, per-CLI revocation, zero us) · `token` =
 *  bearer/header/key via an env-ref or vault slot ("one token, all agents") ·
 *  `none` = open/local. */
export type McpAuthKind = 'oauth' | 'token' | 'none'

/** One catalog row. `verifiedAt` = ISO date the entry was dev-verified with a
 *  real install/login (the 7/01 discipline) — nothing ships as a preset
 *  without one; unverified site names map to registry/custom/bridge instead. */
export interface McpPreset {
  id: string
  label: string
  transport: McpTransport
  /** The remote URL (http) or the launch command line (stdio), verbatim. */
  urlOrCommand: string
  /** Vendor-preferred first; a second kind is the alternate on-ramp the UI
   *  surfaces with the trade stated (per-CLI OAuth vs one vault token). */
  authKinds: readonly McpAuthKind[]
  /** Env var NAMES the entry references as pointers (e.g. "POSTHOG_API_KEY")
   *  — resolved from the user's env or a vault slot (08), never inlined. */
  envRefSlots: readonly string[]
  /** True when the server is self-hostable: Connect offers a base-URL field
   *  replacing the default in `urlOrCommand` (n8n, GitLab). */
  baseUrlOverride?: boolean
  /** Per-CLI dialect notes the writers/UI consult (env expansion vs
   *  inheritance, version floors, header syntax) — dev-verified data. */
  cliQuirks: Readonly<Partial<Record<HostedCliId, string>>>
  /** The consent copy Connect shows — loudest for money-moving and
   *  speaks-as-you servers (Stripe, Slack). Rendered verbatim. */
  grantCopy: string
  /** ISO date of the dev-verification that made this row shippable. */
  verifiedAt: string
}
