// The house REST bridge (ADR 0021, phase-restbridge/02) — pure, Electron-free.
//
// Serves a catalog row's curated `restTools` as real MCP tools: `tools/list` is
// the catalog set verbatim (≤12, agent-worded — this IS the anti-explosion
// surface), `tools/call` is ONE pinned REST request with the vault-held key
// injected server-side. Agents get capabilities, never keys, never URLs of
// their choosing:
//
//   · args are validated against the typed params — unknown/missing/mistyped is
//     a TYPED REFUSAL before any request exists, never a guessy request;
//   · the endpoint is CATALOG-pinned: `${connectionConfig}` placeholders resolve
//     from the stored connection (never from args), path params fill declared
//     `{slots}` encodeURIComponent'd per segment, and a path value carrying
//     `://` or `..` is refused (the pinning law);
//   · `readOnly:false` tools are listed but REFUSE execution unless the calling
//     workspace's grant says writeTools:'all' — the SAME grant MCP write tools
//     ride, resolved at the wiring seam and injected here;
//   · retries ride the catalog `retry` grammar (retryableStatus/retryDelayMs —
//     the credential core's, phase-tools/02), one retry, delay capped;
//   · pagination follows the provider's same-origin `next` link ≤3 pages and
//     says so when more exist; a HARD response cap truncates honestly — an
//     agent context is not a firehose;
//   · failures carry the provider's status + a short body excerpt with the key
//     scrubbed — never headers, never the credential.
//
// The RESTEXEC gate (scripts/restexec-pure-smoke.ts) bites all of it against a
// fixture REST API, including mutation-reds proving the write gate and the
// pinning refusal are load-bearing (`_testDisableWriteGate`/`_testDisablePinning`
// exist for exactly that, the TOOLCRED `_testDisableLock` precedent).

import type { ProviderEntry, RestToolParam, RestToolSpec } from '../../../contracts/integrations/provider-catalog'
import { retryDelayMs, retryableStatus } from './credential-core'

/** Everything the executor needs, resolved at the wiring seam (mcp-endpoint):
 *  the ONE decryption point (`accessTokenFor`) produced `token`; the grant seam
 *  (`getIntegrationsGrant` via the caller's pane→workspace) produced
 *  `writeGranted`. The core never touches a vault or a grant store. */
export interface RestBridgeService {
  entry: ProviderEntry
  token: string
  /** Stored connection-config values (instance URL, region…) — the ONLY source
   *  `${placeholders}` resolve from. Never agent args. */
  connectionConfig?: Readonly<Record<string, string>>
  writeGranted: boolean
  fetchFn?: typeof fetch
  now?: () => number
  timeoutMs?: number
  responseCapBytes?: number
  /** TEST-ONLY (RESTEXEC mutation-reds): prove the assertions bite. */
  _testDisableWriteGate?: boolean
  _testDisablePinning?: boolean
}

const RESPONSE_CAP_BYTES = 50_000
const MAX_PAGES = 3

// ── tools/list: the catalog set, verbatim ────────────────────────────────────

const paramSchema = (p: RestToolParam): Record<string, unknown> => ({
  type: p.type === 'integer' ? 'integer' : p.type,
  ...(p.description ? { description: p.description } : {})
})

/** One tool's MCP inputSchema, derived from the typed params — primitives only,
 *  additionalProperties:false so clients pre-reject junk the executor would
 *  refuse anyway. */
export function restToolInputSchema(tool: RestToolSpec): Record<string, unknown> {
  const params = tool.params ?? []
  return {
    type: 'object',
    properties: Object.fromEntries(params.map((p) => [p.key, paramSchema(p)])),
    required: params.filter((p) => p.required).map((p) => p.key),
    additionalProperties: false
  }
}

/** The MCP tools/list result: names/descriptions verbatim from the catalog. */
export function restToolsListResult(entry: ProviderEntry): { tools: Array<Record<string, unknown>> } {
  return {
    tools: (entry.restTools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: restToolInputSchema(t)
    }))
  }
}

// ── tools/call: validate → pin → inject → execute → shape ────────────────────

export type RestCallOutcome = { ok: boolean; text: string }

const refusal = (text: string): RestCallOutcome => ({ ok: false, text })

/** Dot-path walk (the profile-spec dialect, minus fallbacks). */
function jsonPath(value: unknown, path: string): unknown {
  let cur: unknown = value
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function typedArgError(p: RestToolParam, v: unknown): string | null {
  if (p.type === 'string' && typeof v !== 'string') return `"${p.key}" must be a string`
  if (p.type === 'boolean' && typeof v !== 'boolean') return `"${p.key}" must be a boolean`
  if (p.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return `"${p.key}" must be a number`
  if (p.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v))) return `"${p.key}" must be an integer`
  return null
}

/** Validate args against the typed params. Returns the refusal sentence or the
 *  validated values grouped by carriage. A refusal here means ZERO requests. */
function validateArgs(
  tool: RestToolSpec,
  args: Record<string, unknown>
): { ok: true; byIn: { path: Map<string, string>; query: Map<string, string>; body: Record<string, unknown> } } | { ok: false; text: string } {
  const params = tool.params ?? []
  const known = new Map(params.map((p) => [p.key, p]))
  const valid = params.length ? `Valid params: ${params.map((p) => `${p.key} (${p.type}${p.required ? ', required' : ''})`).join(', ')}.` : 'This tool takes no arguments.'
  for (const k of Object.keys(args)) {
    if (!known.has(k)) return { ok: false, text: `Unknown argument "${k}" for ${tool.name}. ${valid}` }
  }
  const byIn = { path: new Map<string, string>(), query: new Map<string, string>(), body: {} as Record<string, unknown> }
  for (const p of params) {
    const v = args[p.key]
    if (v === undefined) {
      if (p.required) return { ok: false, text: `Missing required argument "${p.key}" for ${tool.name}. ${valid}` }
      continue
    }
    const typeError = typedArgError(p, v)
    if (typeError) return { ok: false, text: `${typeError} for ${tool.name}. ${valid}` }
    if (p.in === 'path') byIn.path.set(p.key, String(v))
    else if (p.in === 'query') byIn.query.set(p.key, String(v))
    else byIn.body[p.key] = v
  }
  return { ok: true, byIn }
}

/** All connectionConfig keys the row's methods declare — the interpolation
 *  allowlist (RESTSCHEMA enforces this statically; the executor re-checks so a
 *  crafted entry can never widen it at runtime). */
const declaredConfigKeys = (entry: ProviderEntry): Set<string> =>
  new Set(entry.methods.flatMap((m) => (m.connectionConfig ?? []).map((c) => c.key)))

/** Resolve the pinned endpoint: `${KEY}` from the STORED config only, `{slot}`
 *  from validated path params, encoded per segment. Any refusal happens before
 *  a request exists. */
function resolveEndpoint(
  entry: ProviderEntry,
  tool: RestToolSpec,
  pathArgs: Map<string, string>,
  config: Readonly<Record<string, string>>,
  pinningDisabled: boolean
): { ok: true; url: string } | { ok: false; text: string } {
  const allowed = declaredConfigKeys(entry)
  let url = tool.endpoint
  const unresolved: string[] = []
  url = url.replace(/\$\{([^}]*)\}/g, (whole, key: string) => {
    const v = allowed.has(key) ? config[key] : undefined
    if (typeof v !== 'string' || !v) {
      unresolved.push(key)
      return whole
    }
    return v
  })
  if (unresolved.length) {
    return { ok: false, text: `${entry.label} needs its ${unresolved.join(', ')} configured in Settings › Integrations before this tool can run.` }
  }
  for (const [key, value] of pathArgs) {
    // The pinning law: a path value must stay a path SEGMENT. `://` (an absolute
    // URL) or `..` (traversal) is an attempt to steer the pinned endpoint — refuse,
    // typed, zero requests. encodeURIComponent besides: a benign `/` or `?` must
    // not restructure the URL either.
    if (!pinningDisabled && (value.includes('://') || value.includes('..'))) {
      return { ok: false, text: `Refused: "${key}" must be a plain path segment for ${tool.name} — it cannot carry a URL or a traversal.` }
    }
    url = url.split(`{${key}}`).join(encodeURIComponent(value))
  }
  const leftover = url.match(/\{([^}]+)\}/)
  if (leftover) return { ok: false, text: `Missing required argument "${leftover[1]}" for ${tool.name}.` }
  return { ok: true, url }
}

/** The key must never echo back to the agent, whatever a provider puts in an
 *  error body. */
const scrub = (s: string, token: string): string => (token ? s.split(token).join('•••') : s)

/** One authed request with the catalog retry grammar: a retryable status gets
 *  ONE retry after the provider's own header-named delay (capped) — slowed by a
 *  rate limit, never hung by one. */
async function fetchWithRetry(
  url: URL,
  init: RequestInit,
  svc: RestBridgeService
): Promise<Response> {
  const doFetch = svc.fetchFn ?? fetch
  const now = svc.now ?? Date.now
  const timeout = (): AbortSignal => AbortSignal.timeout(svc.timeoutMs ?? 15_000)
  let res = await doFetch(url, { ...init, signal: timeout() })
  if (!res.ok && retryableStatus(res.status, svc.entry.retry)) {
    await new Promise((r) => setTimeout(r, retryDelayMs(res.headers, svc.entry.retry, 0, now())))
    res = await doFetch(url, { ...init, signal: timeout() })
  }
  return res
}

/** Execute one curated tool call. Every path out of here is either the shaped
 *  answer or an honest, typed, secret-free sentence. */
export async function executeRestTool(
  name: string,
  args: Record<string, unknown>,
  svc: RestBridgeService
): Promise<RestCallOutcome> {
  const entry = svc.entry
  const tool = (entry.restTools ?? []).find((t) => t.name === name)
  if (!tool) return refusal(`Unknown tool "${name}". This ${entry.label} connection serves: ${(entry.restTools ?? []).map((t) => t.name).join(', ')}.`)

  // THE WRITE GATE: same grant as MCP write tools, resolved at the wiring seam.
  if (tool.readOnly === false && !svc.writeGranted && !svc._testDisableWriteGate) {
    return refusal(
      `${tool.name} changes data at ${entry.label}, and this workspace's Write tools switch is off. ` +
        `Turn Write tools to “All” in Settings › Integrations for this workspace to allow it.`
    )
  }

  const validated = validateArgs(tool, args)
  if (!validated.ok) return refusal(validated.text)
  const pinned = resolveEndpoint(entry, tool, validated.byIn.path, svc.connectionConfig ?? {}, !!svc._testDisablePinning)
  if (!pinned.ok) return refusal(pinned.text)

  const url = new URL(pinned.url)
  for (const [k, v] of validated.byIn.query) url.searchParams.set(k, v)

  // Auth injection — the one place the key meets the request, per the row's
  // single restAuth declaration. It dies with this frame.
  const headers: Record<string, string> = { accept: 'application/json' }
  const auth = entry.restAuth
  if (auth?.in === 'header' && auth.header) {
    headers[auth.header] = auth.scheme ? `${auth.scheme} ${svc.token}` : svc.token
  } else if (auth?.in === 'query' && auth.queryParam) {
    url.searchParams.set(auth.queryParam, svc.token)
  } else {
    return refusal(`${entry.label} has no usable restAuth declaration — this is a catalog bug, not something a different call can fix.`)
  }
  const hasBody = tool.method !== 'GET' && Object.keys(validated.byIn.body).length > 0
  if (hasBody) headers['content-type'] = 'application/json'
  const init: RequestInit = { method: tool.method, headers, ...(hasBody ? { body: JSON.stringify(validated.byIn.body) } : {}) }

  let json: unknown
  try {
    const res = await fetchWithRetry(url, init, svc)
    if (!res.ok) {
      const excerpt = scrub((await res.text().catch(() => '')).slice(0, 200), svc.token).trim()
      return refusal(`${entry.label} answered ${res.status}${excerpt ? `: ${excerpt}` : ''}`)
    }
    json = await res.json().catch(() => null)
  } catch (e) {
    return refusal(`Could not reach ${entry.label}: ${scrub(e instanceof Error ? e.message : String(e), svc.token)}`)
  }

  // Pagination: merge the declared item arrays across the provider's own
  // same-origin `next` links, ≤MAX_PAGES total — and say so when more exist.
  let value: unknown = json
  let morePages = false
  if (tool.pagination) {
    const items: unknown[] = []
    const take = (page: unknown): void => {
      const arr = jsonPath(page, tool.pagination!.itemsPath)
      if (Array.isArray(arr)) items.push(...arr)
    }
    take(json)
    let page = json
    for (let n = 1; n < MAX_PAGES; n++) {
      const next = page && typeof page === 'object' ? (page as Record<string, unknown>).next : undefined
      if (typeof next !== 'string' || !next) break
      let nextUrl: URL
      try {
        nextUrl = new URL(next)
      } catch {
        break
      }
      // The next link is the PROVIDER'S, and still pinned: same origin as the
      // catalog endpoint or it is not followed.
      if (nextUrl.origin !== url.origin) break
      if (auth?.in === 'query' && auth.queryParam) nextUrl.searchParams.set(auth.queryParam, svc.token)
      try {
        const res = await fetchWithRetry(nextUrl, { method: 'GET', headers }, svc)
        if (!res.ok) break
        page = await res.json().catch(() => null)
      } catch {
        break
      }
      take(page)
    }
    const lastNext = page && typeof page === 'object' ? (page as Record<string, unknown>).next : undefined
    morePages = typeof lastNext === 'string' && !!lastNext
    value = items
  } else if (tool.responsePath) {
    value = jsonPath(json, tool.responsePath) ?? json
  }

  let text = JSON.stringify(value)
  if (morePages) text += `\n[More pages exist — this answer merged the first ${MAX_PAGES}. Narrow the call to see later pages.]`
  const cap = svc.responseCapBytes ?? RESPONSE_CAP_BYTES
  if (text.length > cap) {
    text = text.slice(0, cap) + `\n[Truncated: the full response exceeded ~${Math.round(cap / 1000)} KB. Narrow the call (fewer items, a tighter query) to see the rest.]`
  }
  return { ok: true, text }
}

// ── The JSON-RPC face the connection shim forwards to ────────────────────────

interface JsonRpcFrame {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

const rpcResult = (id: number | string | null, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: number | string | null, code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } })

/**
 * Handle one MCP JSON-RPC frame against a rest-bridge service. Returns the
 * response frame, or null for notifications (the spec forbids answering them).
 * Tool refusals are MCP tool errors (`isError` content) — an agent can read and
 * correct them; a protocol error would just kill its session.
 */
export async function handleRestBridgeRpc(payload: unknown, svc: RestBridgeService): Promise<Record<string, unknown> | null> {
  const frame = (payload && typeof payload === 'object' ? payload : {}) as JsonRpcFrame
  const method = String(frame.method ?? '')
  if (frame.id === undefined || frame.id === null) return null // notification
  const id = frame.id
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof frame.params?.protocolVersion === 'string' ? frame.params.protocolVersion : '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mogging-rest-bridge', version: '1.0.0' }
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, restToolsListResult(svc.entry))
    case 'tools/call': {
      const name = String(frame.params?.name ?? '')
      const args = (frame.params?.arguments ?? {}) as Record<string, unknown>
      const out = await executeRestTool(name, args, svc)
      return rpcResult(id, { content: [{ type: 'text', text: out.text }], ...(out.ok ? {} : { isError: true }) })
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })
    default:
      return rpcError(id, -32601, `The ${svc.entry.label} bridge does not speak "${method}".`)
  }
}
