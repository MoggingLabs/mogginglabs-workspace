// The per-workspace integrations grant store (Phase-8/03, ADR 0008.c). Pure
// logic over an injected KV — Electron-free; main wires it to the app-settings
// db. Grants persist as JSON under `integrations.grant.<wsId>` (same store as
// everything else, no schema migration). The 6/05b browser-consent boolean
// migrates on FIRST READ: absent grant + legacy consent -> `web:'public'`
// (today's consent semantics exactly), written back so the migration runs once.

import {
  MCP_CONTROL_WRITE_TOOL_NAMES,
  defaultIntegrationsGrant,
  grantFromLegacyBrowserConsent,
  isSensitiveOrigin,
  type McpWriteToolName,
  type WebGrantLevel,
  type WorkspaceIntegrationsGrant
} from '@contracts'

/** Normalize a user-entered act-origin to a proper ORIGIN string
 *  ("github.com" -> "https://github.com"); null when unparseable. Grants are
 *  exact-origin: scheme + host + port all count. */
export function normalizeActOrigin(raw: string): string | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** The blocklist, both ends (ADR 0008.e): `SENSITIVE_ORIGIN_PATTERNS` plus the
 *  test-only extra pattern (`MOGGING_TEST_BLOCK_ORIGIN`, the AGENTWEB smoke's
 *  hook). The grant editor refuses to SAVE a match; `agentAct` refuses to
 *  DISPATCH one even if persisted — `actOrigins` never overrides it. */
export function isBlockedActOrigin(origin: string): boolean {
  const h = String(origin ?? '').toLowerCase()
  if (isSensitiveOrigin(h)) return true
  const test = process.env.MOGGING_TEST_BLOCK_ORIGIN
  return !!test && h.includes(test.toLowerCase())
}

/** The two KV verbs the store needs (main adapts the app-settings db to this). */
export interface GrantKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

const kvGrant = (wsId: string): string => `integrations.grant.${wsId}`
/** 6/05b's consent key, read for migration ONLY — never written here. */
const kvLegacyConsent = (wsId: string): string => `browser.agentControl.${wsId}`

const WEB_LEVELS: readonly WebGrantLevel[] = ['off', 'public', 'signed-in']

/** Coerce an untrusted value (IPC payload, stored JSON) into a valid grant for
 *  `workspaceId` — unknown tool names drop, bad enums fall to the default,
 *  origins keep only non-empty strings. Never throws; never widens. */
export function sanitizeGrant(workspaceId: string, raw: unknown): WorkspaceIntegrationsGrant {
  const g = defaultIntegrationsGrant(workspaceId)
  if (typeof raw !== 'object' || raw === null) return g
  const r = raw as Record<string, unknown>
  if (r.writeTools === 'all' || r.writeTools === 'none') {
    g.writeTools = r.writeTools
  } else if (Array.isArray(r.writeTools)) {
    const tools = r.writeTools.filter((t): t is McpWriteToolName =>
      (MCP_CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes(t as string)
    )
    // An explicit empty list is 'none' — one spelling for the closed fist.
    g.writeTools = tools.length ? tools : 'none'
  }
  if (WEB_LEVELS.includes(r.web as WebGrantLevel)) g.web = r.web as WebGrantLevel
  if (Array.isArray(r.actOrigins)) {
    // Normalized origins only; blocked (sensitive) origins never save — the
    // editor end of the both-ends rule. Dispatch re-checks independently.
    g.actOrigins = [
      ...new Set(
        r.actOrigins
          .map((o) => normalizeActOrigin(typeof o === 'string' ? o : ''))
          .filter((o): o is string => o !== null && !isBlockedActOrigin(o))
      )
    ].slice(0, 200)
  }
  return g
}

/** Read a workspace's grant. Absent -> defaults; absent + legacy 6/05b consent
 *  -> `web:'public'`, written back (the one-time migration). */
export function readGrant(kv: GrantKv, workspaceId: string): WorkspaceIntegrationsGrant {
  const raw = kv.get(kvGrant(workspaceId))
  if (raw) {
    try {
      return sanitizeGrant(workspaceId, JSON.parse(raw))
    } catch {
      return defaultIntegrationsGrant(workspaceId)
    }
  }
  if (kv.get(kvLegacyConsent(workspaceId)) === '1') {
    const migrated = grantFromLegacyBrowserConsent(workspaceId, true)
    kv.set(kvGrant(workspaceId), JSON.stringify(migrated))
    return migrated
  }
  return defaultIntegrationsGrant(workspaceId)
}

/** Persist a grant (sanitized). A grant equal to the defaults still persists —
 *  an explicit choice is not the same as never-asked (the migration must not
 *  re-run over a deliberate revoke). Returns the sanitized grant. */
export function writeGrant(kv: GrantKv, grant: WorkspaceIntegrationsGrant): WorkspaceIntegrationsGrant {
  const clean = sanitizeGrant(String(grant?.workspaceId ?? ''), grant)
  kv.set(kvGrant(clean.workspaceId), JSON.stringify(clean))
  return clean
}

/** The write-tool names `grant` exposes, resolved against the closed catalog
 *  list — the ONE place 'none'/'all'/list becomes a served set. */
export function grantedWriteToolNames(grant: WorkspaceIntegrationsGrant): McpWriteToolName[] {
  if (grant.writeTools === 'none') return []
  if (grant.writeTools === 'all') return [...MCP_CONTROL_WRITE_TOOL_NAMES]
  return grant.writeTools.filter((t) => (MCP_CONTROL_WRITE_TOOL_NAMES as readonly string[]).includes(t))
}
