// The provider catalog (ADR 0020) — the declarative single source of truth for
// every integration fact: auth methods, identity fetchers, verification probes,
// refresh quirks, retry metadata, humanized scopes, setup links. One JSON per
// service under ./catalog/, validated by ./catalog/schema.json and the CATSCHEMA
// gate (scripts/check-catalog.mjs). Code consumes the catalog; a new provider is
// a data PR with cited provenance. Survey lineage (re-authored, license-clean):
// Nango's providers.yaml taxonomy × Metorial's per-method model — see
// docs/research/2026-07-integrations-oss-survey.md and the license lanes in ADR 0020.
//
// LANDING DARK (phase-tools/01): presets.json remains the runtime source until
// step 05; providerToPreset() below is the migration shim that keeps McpPreset
// consumers a projection away. Nothing here carries a secret — the CATSCHEMA
// gate scans the data for secret-shaped literals on every sweep.

import type { HostedCliId, McpAuthKind, McpPreset, McpTransport } from './presets'

/** How a method authenticates. Extensible enum — Nango's lesson: auth modes have
 *  a long tail (their taxonomy needs 18); a new kind must be data + one strategy,
 *  never a per-provider fork. */
export type ProviderMethodKind = 'oauth' | 'apiKey' | 'cliOwned' | 'none'

/** A humanized scope (Metorial): the UI renders `title`, keeps `scope` in the
 *  title attribute; unknown scopes fall back to the raw string, never hidden. */
export interface ProviderScope {
  scope: string
  title: string
  description?: string
}

/** A typed input field (Activepieces): the paste forms render these — labels,
 *  help text, secret masking — instead of hardcoding per-service fields. */
export interface ProviderInputField {
  key: string
  label: string
  help?: string
  secret?: boolean
  required?: boolean
  placeholder?: string
}

/** A connection-config field (generalizing needsBaseUrl — Nango's
 *  connectionConfig): instance URLs, region codes, anything interpolated into
 *  endpoints as ${placeholders}. */
export interface ProviderConfigField {
  key: string
  label: string
  help?: string
  placeholder?: string
  required?: boolean
}

/** One named auth method (Metorial: GitHub ships four). Rank orders the chooser. */
export interface ProviderMethod {
  key: string
  kind: ProviderMethodKind
  name: string
  rank: number
  /** Provenance for facts unique to this method. */
  source?: string
  endpoints?: {
    /** 'mcp' = discover the AS from the MCP endpoint (RFC 9728, what the
     *  orchestrator already does); 'oidc' = standard OIDC discovery. Explicit
     *  URLs are for the no-DCR providers whose consoles we must name. */
    discovery?: 'mcp' | 'oidc'
    authorizationUrl?: string
    tokenUrl?: string
    refreshUrl?: string
  }
  scopes?: readonly ProviderScope[]
  inputs?: readonly ProviderInputField[]
  connectionConfig?: readonly ProviderConfigField[]
  quirks?: {
    scopeSeparator?: string
    authorizationParams?: Readonly<Record<string, string>>
    /** Seconds subtracted from expires_in when computing expiresAt. */
    tokenExpirationBuffer?: number
    /** Provider omits refresh_token on refresh: keep the old one (GitHub). */
    refreshKeepsToken?: boolean
  }
}

/** How to learn who you are (Metorial's getProfile, as data; step 04 executes). */
export interface ProviderProfileSpec {
  via: 'oidc' | 'rest' | 'tool'
  /** rest: the endpoint (absolute URL). */
  url?: string
  /** tool: the MCP tool name (must also satisfy the executor's allowlist). */
  tool?: string
  /** JSON paths (dot notation, `a||b` fallback) into the response. */
  paths?: { id?: string; email?: string; name?: string; imageUrl?: string }
  source?: string
}

/** Declarative liveness probe for key-auth (Nango's verification blocks; step 03
 *  executes). MCP services default to initialize + tools/list and omit this. */
export interface ProviderVerificationSpec {
  method: 'GET' | 'POST'
  endpoint: string
  headers?: Readonly<Record<string, string>>
  source?: string
}

/** Rate-limit-aware retry metadata (Nango) — the bridge proxy adopts it. */
export interface ProviderRetrySpec {
  atHeader?: string
  remainingHeader?: string
  errorCodes?: readonly string[]
}

/** One catalog row = one service. `source` provenance is BINDING (CATSCHEMA). */
export interface ProviderEntry {
  id: string
  label: string
  /** Provenance: the primary documentation this entry was authored from, or
   *  `repo://presets.json#<id>` for rows migrated mechanically from our own
   *  dev-verified presets pending re-authoring. */
  source: string
  logo?: string
  categories?: readonly string[]
  docs?: string
  setupGuideUrl?: string
  docsLinks?: readonly { type: string; name: string; url: string }[]
  group?: string
  mcp?: { transport: McpTransport; url?: string; command?: string }
  methods: readonly ProviderMethod[]
  profile?: ProviderProfileSpec
  verification?: ProviderVerificationSpec
  retry?: ProviderRetrySpec
  grantCopy?: string
  verifiedAt?: string
}

// ── The migration shim (retired by phase-tools step 05) ──────────────────────
// Projects a ProviderEntry back onto the McpPreset shape today's consumers read,
// so the catalog can land dark while presets.json stays the runtime source. The
// unit test (tests/unit/provider-catalog.test.ts) holds the two in agreement for
// every id present in both.

const KIND_TO_AUTH: Record<ProviderMethodKind, McpAuthKind | null> = {
  oauth: 'oauth',
  apiKey: 'token',
  none: 'none',
  cliOwned: null // a route, not an auth kind — presets never modeled it
}

export function providerToPreset(p: ProviderEntry, cliQuirks: McpPreset['cliQuirks'] = {}): McpPreset {
  const authKinds: McpAuthKind[] = []
  for (const m of [...p.methods].sort((a, b) => a.rank - b.rank)) {
    const kind = KIND_TO_AUTH[m.kind]
    if (kind && !authKinds.includes(kind)) authKinds.push(kind)
  }
  const envRefSlots = [
    ...new Set(
      p.methods.flatMap((m) => (m.inputs ?? []).filter((f) => f.secret).map((f) => f.key))
    )
  ]
  return {
    id: p.id,
    label: p.label,
    transport: p.mcp?.transport ?? 'http',
    urlOrCommand: p.mcp?.url ?? p.mcp?.command ?? '',
    ...(p.group ? { group: p.group } : {}),
    authKinds: authKinds.length ? authKinds : ['none'],
    envRefSlots,
    baseUrlOverride: p.methods.some((m) => (m.connectionConfig ?? []).length > 0) || undefined,
    cliQuirks,
    grantCopy: p.grantCopy ?? '',
    verifiedAt: p.verifiedAt ?? ''
  } as McpPreset
}

/** The chooser's rank order, catalog-driven (step 05 renders this). */
export const providerMethodsRanked = (p: ProviderEntry): ProviderMethod[] =>
  [...p.methods].sort((a, b) => a.rank - b.rank)

/** Which CLI the cliOwned method targets this phase (Claude Code first). */
export const CLI_OWNED_TARGET: HostedCliId = 'claude-code'
