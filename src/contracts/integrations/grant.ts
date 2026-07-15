// The unified per-workspace integrations grant (Phase-8/01, ADR 0008.c/e).
// ONE shape gates both halves: the MCP write tools (03) and the agent's web
// acts (04). Defaults live HERE, not in consumers — an absent grant means
// exactly `defaultIntegrationsGrant(workspaceId)`. The grant is catalog
// hygiene against prompt injection; the reviewer gate stays THE boundary.

import type { McpWriteToolName } from './mcp'

/** Web-session tier for agent browser control (ADR 0008.e):
 *  `off` = agents may not drive the dock at all (the default) ·
 *  `public` = the 6/05b consent, verbatim: agents drive the PUBLIC preview
 *  partition only · `signed-in` = the agent web profile (Branch C) — acting
 *  on a signed-in origin additionally needs that origin in `actOrigins`. */
export type WebGrantLevel = 'off' | 'public' | 'signed-in'

/** Which control-plane write tools the workspace exposes: none (default),
 *  all, or an explicit tool list. Reads are never gated. */
export type WriteToolsGrant = 'none' | 'all' | readonly McpWriteToolName[]

export interface WorkspaceIntegrationsGrant {
  workspaceId: string
  writeTools: WriteToolsGrant
  web: WebGrantLevel
  /** Origins (e.g. "https://github.com") granted for ACT verbs at the
   *  `signed-in` tier. Reading is never gated; the sensitive blocklist
   *  below beats any entry here, always. */
  actOrigins: readonly string[]
}

/** Field/operation-level mutation applied to the latest stored grant. */
export type IntegrationsGrantMutation =
  | { workspaceId: string; field: 'writeTools'; value: WriteToolsGrant }
  | { workspaceId: string; field: 'web'; value: WebGrantLevel }
  | { workspaceId: string; field: 'origin'; op: 'add' | 'remove'; origin: string }

/** The closed-fist default: no pen, no web, no origins. */
export const INTEGRATIONS_GRANT_DEFAULTS: Readonly<Omit<WorkspaceIntegrationsGrant, 'workspaceId'>> = {
  writeTools: 'none',
  web: 'off',
  actOrigins: []
}

export function defaultIntegrationsGrant(workspaceId: string): WorkspaceIntegrationsGrant {
  return { workspaceId, ...INTEGRATIONS_GRANT_DEFAULTS }
}

/** The 6/05b migration, as data logic: the legacy per-workspace consent
 *  boolean maps to `web: 'public'` (today's consent semantics, exactly) —
 *  read-through on first grant access, then written back (03). */
export function grantFromLegacyBrowserConsent(workspaceId: string, consented: boolean): WorkspaceIntegrationsGrant {
  return { ...defaultIntegrationsGrant(workspaceId), web: consented ? 'public' : 'off' }
}

/** The one place the `'none' | 'all' | list` semantics are interpreted. */
export function isWriteToolGranted(
  grant: Pick<WorkspaceIntegrationsGrant, 'writeTools'>,
  tool: McpWriteToolName
): boolean {
  const w = grant.writeTools
  if (w === 'none') return false
  if (w === 'all') return true
  return w.includes(tool)
}

/** Sensitive-origin blocklist (ADR 0007.b clause d · ADR 0008.e). Host
 *  suffixes/fragments, matched case-insensitively. `actOrigins` NEVER
 *  overrides a match: usage store-reads refuse (7/06) and agent-web act
 *  grants refuse (enforced 03/04) — no meter or agent act is worth a
 *  bank/mail/gov session. Moved here from `@contracts/usage` (its comment
 *  always said this was the 8/01 blocklist, needed there first). */
export const SENSITIVE_ORIGIN_PATTERNS: readonly string[] = [
  'bank', 'chase.com', 'wellsfargo', 'paypal', 'venmo', 'coinbase', 'stripe.com',
  'mail.google', 'gmail', 'outlook', 'mail.', 'proton.me',
  '.gov', 'irs.gov', 'ssa.gov',
  // Matched against ORIGINS, which never carry a path — a pattern with a '/'
  // in it can never fire. Apple's account surface is its own host.
  'icloud.com', 'appleid.apple.com'
]
export function isSensitiveOrigin(origin: string): boolean {
  const h = origin.toLowerCase()
  return SENSITIVE_ORIGIN_PATTERNS.some((p) => h.includes(p))
}
