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

/** How an API key rides a bridge request (ADR 0021) — ONE declaration per
 *  service, reused by every restTool: a header (name + optional scheme, e.g.
 *  `Authorization: Bearer <key>`) or a query param. DARK until the step-02
 *  executor; RESTSCHEMA validates it now. */
export interface RestAuthSpec {
  in: 'header' | 'query'
  /** header carriage: the header name (required when in === 'header'). */
  header?: string
  /** header carriage: the scheme prefixed to the key (e.g. 'Bearer'). */
  scheme?: string
  /** query carriage: the param name (required when in === 'query'). */
  queryParam?: string
  source?: string
}

/** One typed parameter of a curated REST tool. Path params fill declared
 *  `{slots}` in the pinned endpoint. */
export interface RestToolParam {
  key: string
  in: 'path' | 'query' | 'body'
  type: 'string' | 'number' | 'integer' | 'boolean'
  required?: boolean
  description?: string
}

/** One curated REST tool (ADR 0021): declarative, capped, provenance-pinned.
 *  The endpoint is CATALOG-pinned https; its only interpolation is declared
 *  `${connectionConfig}` keys — the bridge never executes an agent-supplied URL.
 *  `name`/`description` are written for an agent choosing tools, never mirrored
 *  from a spec (Speakeasy's curation doctrine as law). */
export interface RestToolSpec {
  /** Agent-facing, snake_case, ≤40 chars. */
  name: string
  /** One sentence, written for an agent choosing tools. */
  description: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  endpoint: string
  params?: readonly RestToolParam[]
  /** Default true; `false` marks a WRITE tool — gated by the per-workspace
   *  write grant exactly like an MCP write tool. Non-GET methods must declare
   *  this explicitly (RESTSCHEMA). */
  readOnly?: boolean
  /** Cursor/page param names + the JSON path to the item array. */
  pagination?: { cursorParam?: string; pageParam?: string; itemsPath: string }
  /** JSON path shaping the answer the bridge returns. */
  responsePath?: string
  /** Per-tool provenance: the primary API doc this tool was re-authored from. */
  source: string
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
  /** Per-CLI dialect notes the writers/UI consult (env expansion vs inheritance,
   *  header syntax) — dev-verified data, moved in from presets.json at step 05. */
  cliQuirks?: Readonly<Partial<Record<HostedCliId, string>>>
  methods: readonly ProviderMethod[]
  profile?: ProviderProfileSpec
  verification?: ProviderVerificationSpec
  retry?: ProviderRetrySpec
  // ── The REST bridge block (ADR 0021, phase-restbridge/01) — DARK: no runtime
  // reads these until the step-02 executor; RESTSCHEMA gate-hardens the shape
  // now, and the McpPreset projection below ignores them (unit-pinned).
  /** How the key rides — one declaration reused by every restTool. */
  restAuth?: RestAuthSpec
  /** The provider's own permission names the curated set needs (least
   *  privilege as data). Required alongside restTools. */
  requiredPermissions?: readonly string[]
  /** PRE-FILLED token-creation link: click → Create → copy. */
  setupTokenUrl?: string
  /** Curated tools the house bridge serves — hard cap 12, ≥1 read-only. */
  restTools?: readonly RestToolSpec[]
  grantCopy?: string
  verifiedAt?: string
}

// ── The projection onto McpPreset (the RETIRED shim's successor, step 05) ─────
// The catalog is the runtime source now: presets.json is gone, and the projection
// below is how the remaining McpPreset consumers read the catalog. The unit test
// (tests/unit/provider-catalog.test.ts) pins its invariants.

const KIND_TO_AUTH: Record<ProviderMethodKind, McpAuthKind | null> = {
  oauth: 'oauth',
  apiKey: 'token',
  none: 'none',
  cliOwned: null // a route, not an auth kind — the preset shape never modeled it
}

/** Project one catalog entry onto the McpPreset shape existing consumers read.
 *  Facts only — every field derives from the entry; nothing is typed twice. */
export function presetFromProvider(p: ProviderEntry): McpPreset {
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
    cliQuirks: p.cliQuirks ?? {},
    grantCopy: p.grantCopy ?? '',
    verifiedAt: p.verifiedAt ?? ''
  } as McpPreset
}

/** The chooser's rank order, catalog-driven (step 05 renders this). */
export const providerMethodsRanked = (p: ProviderEntry): ProviderMethod[] =>
  [...p.methods].sort((a, b) => a.rank - b.rank)

/** Which CLI the cliOwned method targets this phase (Claude Code first). */
export const CLI_OWNED_TARGET: HostedCliId = 'claude-code'
