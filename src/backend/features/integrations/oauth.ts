import { createHash, randomBytes } from 'node:crypto'
import type { OAuthClientRecord } from '@contracts'
import { normalizeTokenResponse, type NormalizeQuirks } from './credential-core'

// The MCP OAuth 2.1 client (ADR 0014). Electron-free on purpose: everything here
// is a pure function of the network, so the gate can drive it against a fixture
// server with no app running.
//
// The flow is the one the MCP spec mandates, and nothing more:
//   1. POST the MCP endpoint with no token -> 401 + `WWW-Authenticate` carrying a
//      `resource_metadata` URL (RFC 9728). We FOLLOW that pointer; we never guess
//      the well-known path from the origin — the metadata is path-scoped, and
//      guessing is exactly how a discovery probe silently misses GitHub's.
//   2. GET the resource metadata -> `authorization_servers[0]`.
//   3. GET the AS metadata (RFC 8414), path-aware then root.
//   4. If it advertises a `registration_endpoint`, REGISTER OURSELVES (RFC 7591) —
//      no vendor paperwork, no shipped client secret. Most of the catalog does.
//      Where it doesn't (github.com, Slack), a pre-registered client id is
//      REQUIRED and we say so in words a human can act on.
//   5. Authorization code + PKCE(S256) through the user's OWN browser, on a
//      loopback redirect. The app never sees their password, and the consent
//      screen is the vendor's real one.
//
// `resource` (RFC 8707) rides both the authorize and token requests: it binds the
// token to THIS MCP server, so a token minted for one service cannot be replayed
// at another. The spec requires it; several servers reject the exchange without it.

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
  userinfo_endpoint?: string
  /** RFC 7009 — where a logout best-effort-revokes the grant it is forgetting. */
  revocation_endpoint?: string
  /** RFC 8414 / OIDC discovery — where the AS publishes its signing keys, so an
   *  id_token's signature is VERIFIED (OIDC Core §3.1.3.7), never just decoded. */
  jwks_uri?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Absolute ms. Absent when the provider issues a non-expiring token. */
  expiresAt?: number
  /** Absolute ms — GitHub-style `refresh_token_expires_in`, normalized at the
   *  credential-core seam. Additive (phase-tools/02): vault records written
   *  before it exist without it and read fine — the fields below are the
   *  v-next shim, all optional by construction. */
  refreshTokenExpiresAt?: number
  /** Almost always `Bearer`; absent on legacy records (read as Bearer). */
  tokenType?: string
  /** When the exchange/refresh happened — absent on legacy records. */
  obtainedAt?: number
  scopes?: string[]
  /** OIDC only. Only Vercel and GitLab offer it across the whole catalog. */
  idToken?: string
  /**
   * The provider's FULL token response, extra fields and all.
   *
   * Most MCP servers are not OIDC — measured: 8 of 10 in the catalog publish no
   * `userinfo_endpoint` and no `openid` scope. But several of them name the account
   * right here, in non-standard fields alongside the token, and nowhere else:
   * Notion sends `owner.user.name` + `workspace_name`, Slack sends `team.name`,
   * Stripe sends `stripe_user_id`. Throwing this response away — which is what the
   * first version did — is throwing away the answer to "whose account is this?".
   *
   * NEVER PERSISTED. `storeTokens` strips it. It lives only long enough to resolve a
   * display name, because a provider may put anything in here, including secrets we
   * did not ask for and have no business keeping.
   */
  raw?: Record<string, unknown>
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** RFC 7636. The verifier is the secret; the challenge is what crosses the wire. */
export function createPkce(): PkcePair {
  // 32 random bytes -> 43 base64url chars, the spec's minimum length exactly.
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export const createState = (): string => base64url(randomBytes(16))

function base64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const jsonHeaders = { accept: 'application/json', 'content-type': 'application/json' }

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Step 1+2+3: the MCP endpoint tells us where its authorization server is.
 *
 *  `requireAuth` exists because a 200 on unauthenticated `initialize` does NOT mean
 *  the server is open. Google's Workspace MCP servers answer `initialize` AND
 *  `tools/list` with no credential and gate at tool-CALL time — measured, not
 *  hypothesized. Without this flag, an oauth preset that never challenges would
 *  have "connected" credential-less: a green card over a service every agent call
 *  bounces off. With it, we go hunting for the resource metadata directly. */
export async function discoverAuthServer(
  mcpUrl: string,
  opts: { requireAuth?: boolean } = {}
): Promise<
  | { ok: true; metadata: AuthServerMetadata; resource: string; resourceScopes?: string[] }
  | { ok: false; reason: string; noAuthNeeded?: boolean }
> {
  let probe: Response
  try {
    probe = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'MoggingLabs Workspace', version: '1' } }
      }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch (e) {
    return { ok: false, reason: `Could not reach ${hostOf(mcpUrl)}: ${short(e)}` }
  }
  const target = new URL(mcpUrl)
  const path = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '')
  if (probe.status === 200 && !opts.requireAuth) {
    return { ok: false, reason: 'This server needs no account — it is ready to use.', noAuthNeeded: true }
  }
  if (probe.status !== 401 && probe.status !== 403 && probe.status !== 200) {
    return { ok: false, reason: `${hostOf(mcpUrl)} answered ${probe.status}, not an OAuth challenge.` }
  }
  // FOLLOW the pointer. Falling back to the origin's well-known is a guess, and a
  // guess that "works" for eight vendors and silently mis-reads the ninth. A server
  // that never challenged (Google) has no pointer to follow — for those, and for
  // challenges without RFC 9728 metadata, try the path-scoped well-knowns directly.
  const header = probe.headers.get('www-authenticate') ?? ''
  const pointer = /resource_metadata="?([^",\s]+)"?/.exec(header)?.[1]
  const prmCandidates = pointer
    ? [pointer]
    : [
        `${target.origin}/.well-known/oauth-protected-resource${path}`,
        `${target.origin}/.well-known/oauth-protected-resource`
      ]
  let prm: { authorization_servers?: string[]; scopes_supported?: string[] } | null = null
  for (const candidate of prmCandidates) {
    prm = await getJson<{ authorization_servers?: string[]; scopes_supported?: string[] }>(candidate)
    if (prm?.authorization_servers?.length) break
  }
  const asUrl =
    prm?.authorization_servers?.[0] ??
    // Some servers challenge without RFC 9728 metadata at all. The spec allows the
    // AS to BE the resource origin; try that before refusing.
    target.origin
  const metadata = await fetchAuthServerMetadata(asUrl)
  if (!metadata) {
    return {
      ok: false,
      reason:
        probe.status === 200
          ? `${hostOf(mcpUrl)} accepts unauthenticated sessions but advertises no way to sign in — its tools would fail at call time. Use the per-CLI path for this one.`
          : `${hostOf(asUrl)} did not publish OAuth metadata, so we cannot connect it automatically.`
    }
  }
  // RFC 8707: the canonical resource identifier for an MCP server is its URL,
  // minus any fragment. Servers compare it byte-for-byte.
  //
  // `resourceScopes` is the narrow, correct ask — carrying it out of here is the whole
  // reason we do not fall back to the AS's platform-wide list. See pickScopes.
  return {
    ok: true,
    metadata,
    resource: canonicalResource(mcpUrl),
    resourceScopes: Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.map(String) : undefined
  }
}

/** RFC 8414 §3: for an issuer with a path, the well-known is INSERTED before the
 *  path — not appended to the origin. Try both, plus the OIDC spelling. */
export async function fetchAuthServerMetadata(asUrl: string): Promise<AuthServerMetadata | null> {
  let u: URL
  try {
    u = new URL(asUrl)
  } catch {
    return null
  }
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`
  ]
  for (const c of candidates) {
    const meta = await getJson<AuthServerMetadata>(c)
    if (meta?.authorization_endpoint && meta.token_endpoint) return meta
  }
  return null
}

export const canonicalResource = (mcpUrl: string): string => {
  const u = new URL(mcpUrl)
  u.hash = ''
  return u.toString()
}

/** RFC 7591. The app registers ITSELF as a public client — no shipped secret, no
 *  vendor sign-up. Returns a reason (not a throw) when the AS has no DCR: that is
 *  a real, user-actionable state ("this one needs a registered app"), not a bug. */
export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string
): Promise<{ ok: true; client: OAuthClientRecord } | { ok: false; reason: string }> {
  if (!metadata.registration_endpoint) {
    return {
      ok: false,
      reason: `${hostOf(metadata.issuer)} does not allow apps to register themselves, so this one needs a pre-registered client id.`
    }
  }
  try {
    const res = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        client_name: 'MoggingLabs Workspace',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // `none` = a PUBLIC client: PKCE is the proof, and there is no secret for
        // us to ship in an app bundle where every user could read it.
        token_endpoint_auth_method: 'none',
        application_type: 'native'
      }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return { ok: false, reason: `${hostOf(metadata.issuer)} refused the registration (${res.status}).` }
    const body = (await res.json()) as { client_id?: string; client_secret?: string }
    if (!body.client_id) return { ok: false, reason: `${hostOf(metadata.issuer)} registered us without a client id.` }
    return {
      ok: true,
      client: {
        authServer: metadata.issuer,
        clientId: body.client_id,
        clientSecret: body.client_secret,
        registeredAt: Date.now()
      }
    }
  } catch (e) {
    return { ok: false, reason: `Could not register with ${hostOf(metadata.issuer)}: ${short(e)}` }
  }
}

/**
 * What to ASK FOR — and, far more importantly, what not to.
 *
 * The RESOURCE declares the scopes it needs (RFC 9728 `scopes_supported` on the
 * protected-resource metadata). The AUTHORIZATION SERVER declares every scope the whole
 * platform has. These are not the same list, and reaching for the wrong one is how an
 * MCP client quietly asks for the world:
 *
 *   gitlab.com  AS says:       api read_api read_user create_runner manage_runner k8s_proxy
 *   gitlab.com  RESOURCE says: mcp
 *
 * Defaulting to the AS's list — which this function used to do — would have put a consent
 * screen in front of the user asking to manage their runners and proxy their Kubernetes
 * cluster, to read some issues. Ask the resource. If the resource declares nothing, ask for
 * NOTHING and let the server apply its own default; that is what the spec intends, and it
 * is strictly safer than guessing.
 *
 * The one addition: identity scopes, and only where the AS actually offers them. `openid`
 * / `email` / `profile` are what let the card say WHOSE account this is. They grant no
 * access to anything.
 */
export function pickScopes(resourceScopes: string[] | undefined, metadata: AuthServerMetadata): string[] {
  const asked = [...(resourceScopes ?? [])]
  const offered = new Set(metadata.scopes_supported ?? [])
  for (const identity of ['openid', 'email', 'profile']) {
    if (offered.has(identity) && !asked.includes(identity)) asked.push(identity)
  }
  return asked
}

export function buildAuthorizeUrl(o: {
  metadata: AuthServerMetadata
  clientId: string
  redirectUri: string
  resource: string
  challenge: string
  state: string
  scopes?: string[]
}): string {
  const u = new URL(o.metadata.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', o.clientId)
  u.searchParams.set('redirect_uri', o.redirectUri)
  u.searchParams.set('code_challenge', o.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', o.state)
  u.searchParams.set('resource', o.resource) // RFC 8707 — bind the token to THIS server
  // No fallback to `metadata.scopes_supported`. An empty ask is correct and safe; asking
  // for every scope a platform has is neither. See pickScopes.
  if (o.scopes?.length) u.searchParams.set('scope', o.scopes.join(' '))
  return u.toString()
}

async function tokenRequest(
  metadata: AuthServerMetadata,
  client: OAuthClientRecord,
  form: Record<string, string>,
  quirks?: NormalizeQuirks
): Promise<{ ok: true; tokens: OAuthTokens } | { ok: false; reason: string }> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId })
  // A confidential client (rare — only when DCR handed us a secret) authenticates
  // the token call. A public client proves itself with the PKCE verifier alone.
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  let res: Response
  try {
    res = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000)
    })
  } catch (e) {
    return { ok: false, reason: `Could not reach ${hostOf(metadata.token_endpoint)}: ${short(e)}` }
  }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    // A connection reset mid-body must not reject out of here — every caller (refreshTokens
    // -> doRefresh -> accessTokenFor) expects a typed result, and a rejection there hangs the
    // connection bridge / rejects the ipcMain handle. Treat an unreadable body as a failure.
    return { ok: false, reason: `Could not read the response from ${hostOf(metadata.token_endpoint)}: ${short(e)}` }
  }
  if (!res.ok) {
    // The AS's own `error_description` is almost always the most useful sentence
    // available — surface it rather than our paraphrase of a status code.
    let detail = `${res.status}`
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string }
      detail = j.error_description ?? j.error ?? detail
    } catch {
      /* not JSON — the status stands */
    }
    return { ok: false, reason: String(detail).slice(0, 200) }
  }
  // THE normalization seam (phase-tools/02, credential-core): every raw token
  // response — JSON or form-encoded, GitHub-quirked or standard — becomes the
  // canonical shape HERE, and no downstream code ever reads a raw field. The
  // raw object still rides OAuthTokens.raw for connect-time account discovery
  // (Notion/Slack/Stripe name the account in non-standard fields) and is
  // stripped at the vault's own choke point, exactly as before.
  const normalized = normalizeTokenResponse(text, res.headers.get('content-type'), { quirks })
  if (!normalized.ok) {
    return {
      ok: false,
      reason: normalized.reason === 'The provider returned no access token.'
        ? normalized.reason
        : `${hostOf(metadata.token_endpoint)} did not return a token.`
    }
  }
  const c = normalized.credential
  return {
    ok: true,
    tokens: {
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      expiresAt: c.expiresAt,
      refreshTokenExpiresAt: c.refreshTokenExpiresAt,
      tokenType: c.tokenType,
      obtainedAt: c.obtainedAt,
      scopes: c.scopes,
      idToken: typeof normalized.raw.id_token === 'string' ? normalized.raw.id_token : undefined,
      raw: normalized.raw
    }
  }
}

export const exchangeCode = (
  metadata: AuthServerMetadata,
  client: OAuthClientRecord,
  o: { code: string; verifier: string; redirectUri: string; resource: string; quirks?: NormalizeQuirks }
): Promise<{ ok: true; tokens: OAuthTokens } | { ok: false; reason: string }> =>
  tokenRequest(
    metadata,
    client,
    {
      grant_type: 'authorization_code',
      code: o.code,
      code_verifier: o.verifier,
      redirect_uri: o.redirectUri,
      resource: o.resource
    },
    o.quirks
  )

/** Rotation-safe by construction: ONE holder means no two refreshers can race.
 *  The caller must persist the returned refresh token — many providers rotate it
 *  on every use, and dropping the new one strands the grant permanently. */
export const refreshTokens = (
  metadata: AuthServerMetadata,
  client: OAuthClientRecord,
  o: { refreshToken: string; resource: string; quirks?: NormalizeQuirks }
): Promise<{ ok: true; tokens: OAuthTokens } | { ok: false; reason: string }> =>
  tokenRequest(
    metadata,
    client,
    {
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      resource: o.resource
    },
    o.quirks
  )

/**
 * The rotation-merge rule, as a pure function so the regression suite can bite on it.
 *
 * Two failure modes, one line each:
 *   · the provider ROTATED the refresh token → we must persist the NEW one (the old is
 *     already invalid; keeping it strands the grant at the next expiry, hours from the
 *     cause);
 *   · the provider did NOT return a refresh token on refresh (many don't) → we must KEEP
 *     the previous one (persisting `undefined` over it strands the grant just as dead).
 */
export const mergeRefreshedTokens = (prev: OAuthTokens, next: OAuthTokens): OAuthTokens => ({
  ...next,
  refreshToken: next.refreshToken ?? prev.refreshToken
})

// ── Talking to the MCP server itself ────────────────────────────────────────

/** One JSON-RPC round trip to a streamable-HTTP MCP server.
 *
 *  Streamable HTTP may answer a plain request with `text/event-stream` — the same
 *  response, wrapped in SSE frames. A client that only parses `application/json`
 *  works against half the catalog and mysteriously "returns nothing" for the rest,
 *  so both shapes are decoded here, once, for every caller. */
export async function mcpFetch(
  url: string,
  payload: unknown,
  o: { token?: string; sessionId?: string; timeoutMs?: number; authScheme?: string } = {}
): Promise<
  | { ok: true; result: unknown; sessionId?: string }
  | { ok: false; status?: number; reason: string; retryHeaders?: Record<string, string> }
> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        // `authScheme` because not every token server speaks Bearer: fal.ai wants
        // `Authorization: Key <k>` (its own docs; the codex cliQuirk exists because
        // codex CANNOT send it). OAuth grants are always Bearer — this only varies
        // for pasted keys, and probeWithSchemes discovers which one works.
        ...(o.token ? { authorization: `${o.authScheme ?? 'Bearer'} ${o.token}` } : {}),
        ...(o.sessionId ? { 'mcp-session-id': o.sessionId } : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000)
    })
  } catch (e) {
    return { ok: false, reason: `Could not reach ${hostOf(url)}: ${short(e)}` }
  }
  const sessionId = res.headers.get('mcp-session-id') ?? undefined
  if (!res.ok) {
    // Rate-limit headers ride the failure so the proxy's catalog-driven retry
    // (phase-tools/02) can honor the provider's own reset stamp — generically
    // captured, because which header matters is the CATALOG's knowledge, not ours.
    const retryHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (/retry-after|ratelimit/i.test(k)) retryHeaders[k.toLowerCase()] = v
    })
    return { ok: false, status: res.status, reason: `${hostOf(url)} answered ${res.status}`, retryHeaders }
  }
  // A notification (no id) is answered with 202 and an empty body — not an error.
  if (res.status === 202) return { ok: true, result: null, sessionId }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    return { ok: false, reason: `Could not read the response from ${hostOf(url)}: ${short(e)}` }
  }
  if (!text.trim()) return { ok: true, result: null, sessionId }
  const body = res.headers.get('content-type')?.includes('text/event-stream') ? lastSseData(text) : text
  if (!body) return { ok: false, reason: `${hostOf(url)} sent an empty event stream.` }
  try {
    return { ok: true, result: JSON.parse(body), sessionId }
  } catch {
    return { ok: false, reason: `${hostOf(url)} sent a response we could not parse.` }
  }
}

/** The LAST `data:` payload in an SSE body — a server may send progress frames
 *  before the real answer. Multi-line `data:` fields concatenate, per the spec. */
export function lastSseData(text: string): string | null {
  let last: string | null = null
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/).filter((l) => l.startsWith('data:'))
    if (!lines.length) continue
    last = lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n')
  }
  return last
}

export interface ConnectionProbe {
  serverName?: string
  toolCount: number
  /** Tool NAMES as listed — capped so a pathological server cannot balloon the
   *  settings KV; the count above stays the true total. */
  tools: string[]
  /** Whose account this is, when the SERVER can tell us. See askServerWhoAmI. */
  account?: string
}

/** Card-and-KV cap for the tool-name list. 200 names ≈ every real server today
 *  (the largest in the verified catalog serves ~60); the COUNT is still honest
 *  past the cap. */
const TOOL_LIST_CAP = 200

/** Tools that answer "who am I?", as MCP servers across the catalog actually spell it.
 *
 *  We call one ONLY if the server advertised it in its own `tools/list`, it takes no
 *  required arguments, and its name is on this list. That is a deliberately small,
 *  read-only door: we are not fishing through a user's account, we are asking the
 *  server the one question it already offers to answer. */
const WHOAMI_TOOLS = new Set([
  'whoami',
  'who_am_i',
  'get_me',
  'getme',
  'get_current_user',
  'getcurrentuser',
  'current_user',
  'get_authenticated_user',
  'get_user_info',
  'getuserinfo',
  'get_user',
  'me'
])

/** The JSON-RPC envelope's own error, when the transport succeeded but the server said
 *  no. Without this, an auth failure a server reports IN-BAND ("invalid token", 200 OK)
 *  surfaced as the baffling "did not list any tools" instead of the server's sentence. */
function envelopeError(result: unknown): string | null {
  const err = (result as { error?: { message?: unknown } } | null)?.error
  if (!err) return null
  return typeof err.message === 'string' && err.message.trim() ? err.message.trim().slice(0, 200) : 'the server refused the request'
}

/** PROOF the connection works: initialize, list the tools, and — where the server
 *  offers it — ask whose account this is. This is what lets a card say
 *  "Connected as pedro@… · 24 tools" instead of inferring connectedness from the
 *  presence of a config block, or from the word "Connected" in a CLI's stdout. */
export async function probeConnection(
  url: string,
  token?: string,
  opts: { authScheme?: string } = {}
): Promise<{ ok: true; probe: ConnectionProbe } | { ok: false; reason: string; unauthorized?: boolean }> {
  const authScheme = opts.authScheme
  const init = await mcpFetch(
    url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'MoggingLabs Workspace', version: '1' }
      }
    },
    { token, authScheme }
  )
  if (!init.ok) return { ok: false, reason: init.reason, unauthorized: init.status === 401 || init.status === 403 }
  const initRefused = envelopeError(init.result)
  if (initRefused) return { ok: false, reason: `${hostOf(url)}: ${initRefused}`, unauthorized: /auth|token|credential/i.test(initRefused) }
  const initResult = (init.result as { result?: { serverInfo?: { name?: string } } })?.result
  const sessionId = init.sessionId
  // The spec REQUIRES `notifications/initialized` before any other request. Servers
  // that enforce it answer `tools/list` with an error until it arrives.
  await mcpFetch(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, sessionId, authScheme })
  const list = await mcpFetch(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token, sessionId, authScheme })
  if (!list.ok) return { ok: false, reason: list.reason, unauthorized: list.status === 401 || list.status === 403 }
  const listRefused = envelopeError(list.result)
  if (listRefused) return { ok: false, reason: `${hostOf(url)}: ${listRefused}` }
  const tools = (list.result as { result?: { tools?: McpToolDecl[] } })?.result?.tools
  if (!Array.isArray(tools)) return { ok: false, reason: `${hostOf(url)} did not list any tools.` }
  // Reuse the session we already have — asking again would cost a whole second handshake.
  const account = token ? await askServerWhoAmI(url, token, sessionId, tools, authScheme) : undefined
  const toolNames = tools
    .map((t) => String(t?.name ?? '').slice(0, 64))
    .filter(Boolean)
    .slice(0, TOOL_LIST_CAP)
  return {
    ok: true,
    probe: { serverName: initResult?.serverInfo?.name, toolCount: tools.length, tools: toolNames, account: account ?? undefined }
  }
}

/**
 * Probe a pasted KEY, discovering which Authorization scheme the server takes.
 *
 * Bearer first (the overwhelming default), then `Key` (fal.ai's spelling) — but the
 * fallback runs ONLY when Bearer was refused as UNAUTHORIZED, so a network failure or a
 * server error never gets misread as "wrong scheme". Whichever succeeds is returned so
 * the caller can persist it and the proxy can keep using it; guessing per call would
 * mean every agent request paying a failed round trip on Key-scheme servers.
 */
export async function probeWithSchemes(
  url: string,
  key: string
): Promise<
  | { ok: true; probe: ConnectionProbe; authScheme: string }
  | { ok: false; reason: string; unauthorized?: boolean }
> {
  const bearer = await probeConnection(url, key, { authScheme: 'Bearer' })
  if (bearer.ok) return { ok: true, probe: bearer.probe, authScheme: 'Bearer' }
  if (!bearer.unauthorized) return bearer
  const keyScheme = await probeConnection(url, key, { authScheme: 'Key' })
  if (keyScheme.ok) return { ok: true, probe: keyScheme.probe, authScheme: 'Key' }
  // Both refused: report the BEARER failure — it is the scheme the user would expect,
  // and "key refused" twice adds nothing.
  return bearer
}

interface McpToolDecl {
  name?: string
  inputSchema?: { required?: unknown }
}

/**
 * Ask the SERVER whose account this is.
 *
 * This exists because the OAuth layer usually cannot answer. Measured across the
 * catalog: 8 of 10 servers publish no `userinfo_endpoint` and no `openid` scope, so an
 * OIDC-only identity story names the account on two cards and shrugs at the rest.
 *
 * The server always knows, though — it is serving that account's data. Most of them
 * expose the answer as an ordinary read-only tool, and this asks for it, under three
 * rules that keep it from being a fishing expedition:
 *
 *   1. the tool must appear in the server's OWN `tools/list` — we never call blind;
 *   2. its name must be on WHOAMI_TOOLS — not "any tool that sounds useful";
 *   3. it must take NO required arguments — so the call cannot mean anything but "read".
 *
 * A server with no such tool simply yields no name, and the card says so honestly.
 */
export async function askServerWhoAmI(
  url: string,
  token: string,
  sessionId: string | undefined,
  tools: McpToolDecl[],
  authScheme?: string
): Promise<string | null> {
  const tool = tools.find((t) => {
    const name = String(t?.name ?? '').toLowerCase()
    if (!WHOAMI_TOOLS.has(name)) return false
    const required = t?.inputSchema?.required
    return !Array.isArray(required) || required.length === 0
  })
  if (!tool?.name) return null
  const res = await mcpFetch(
    url,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool.name, arguments: {} } },
    { token, sessionId, timeoutMs: 15_000, authScheme }
  )
  if (!res.ok) return null
  const result = (res.result as { result?: { isError?: boolean; content?: { type?: string; text?: string }[] } })?.result
  if (!result || result.isError) return null
  // MCP answers in content blocks. The useful ones are text, and the text is usually
  // JSON — but not always, so a plain string is a legitimate answer too.
  const text = (result.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
  if (!text) return null
  try {
    return pickIdentity(JSON.parse(text) as Record<string, unknown>)
  } catch {
    // Not JSON. Take the first non-empty line if it is short enough to be a name and
    // not a paragraph of prose — a card is not a place to dump a tool's essay.
    const first = text.split('\n')[0].trim()
    return first.length > 0 && first.length <= 80 ? first : null
  }
}

/**
 * Whose account is this? Ask everything that could know, cheapest first, and stop at
 * the first real answer. Returns null rather than inventing one — a card that says
 * "Connected" is honest; a card that says "Connected as someone" is not.
 */
export async function discoverAccount(tokens: OAuthTokens, metadata: AuthServerMetadata): Promise<string | null> {
  // 1. OIDC id_token — free, already in hand. (Vercel, GitLab.)
  const fromId = tokens.idToken ? claimFromJwt(tokens.idToken) : null
  if (fromId) return fromId

  // 2. The token RESPONSE's own non-standard fields — also free, also already in hand,
  //    and for much of the catalog this is the ONLY place the email/name exists.
  const fromRaw = tokens.raw ? pickIdentity(tokens.raw) : null
  if (fromRaw) return fromRaw

  // 3. The access token may itself be a JWT carrying claims. Still free.
  const fromAccess = claimFromJwt(tokens.accessToken)
  if (fromAccess) return fromAccess

  // 4. A userinfo endpoint, if the AS has one. (GitLab, across this catalog.)
  if (!metadata.userinfo_endpoint) return null
  try {
    const res = await fetch(metadata.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    return pickIdentity((await res.json()) as Record<string, unknown>)
  } catch {
    return null
  }
}

/** Read the display claim out of a JWT. We do NOT verify its signature, and that is
 *  deliberate and safe: it arrived over TLS, direct from the token endpoint, in the
 *  reply to our own PKCE-proven exchange. It authorizes nothing — it prints a name on
 *  a card. (A JWT we cannot even parse simply yields null.) */
function claimFromJwt(jwt: string): string | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3 || !parts[1]) return null
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    // A JWT's claims are flat, but pickIdentity handles that as a depth-0 walk — and it
    // prefers the `email` claim, which is exactly what an id_token with the `email` scope
    // carries. `sub` alone is an opaque id and is deliberately not treated as a name.
    return pickIdentity(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

// Keys that hold, in order of what we'd rather show: an EMAIL (the unambiguous one — a
// display name answers "who roughly", an email answers "which exact login"), a display
// NAME, and the workspace/org/team a grant is SCOPED to (half the answer to "which
// account?", and for Notion or Slack the half the user actually recognises).
const EMAIL_KEYS = new Set(['email', 'email_address', 'emailaddress', 'mail', 'upn', 'userprincipalname'])
const NAME_KEYS = new Set([
  'name', 'display_name', 'displayname', 'full_name', 'fullname', 'preferred_username', 'username', 'login', 'handle', 'nickname'
])
const SCOPE_KEYS = new Set(['workspace_name', 'team_name', 'organization', 'org', 'account_name', 'tenant'])
const looksLikeEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

/**
 * The strongest identifier a provider gives us, preferring an EMAIL — and finding it even
 * when the provider buries it deeper than a display name.
 *
 * This is the fix for a real bug. Notion's token response nests the two like this:
 *
 *   owner.user.name          = "Pedro Veloso"           ← shallower
 *   owner.user.person.email  = "pedro@mogginglabs.com"  ← one level deeper
 *
 * A walk that returns the first name-shaped value it meets grabs the display name purely
 * because it sits one level up — throwing away the better identifier that was right there
 * in the same response. So we do NOT stop at the first hit. We walk the whole (small)
 * object collecting each kind independently, and choose at the end:
 *
 *   keyed email  >  display name  >  a loose email-shaped string anywhere
 *
 * A *keyed* email (a value under an `email`-ish key) beats a name; a merely email-SHAPED
 * string found under some other key is the last resort, so a stray `billing_email` never
 * outranks the user's actual display name. Whatever wins is qualified by the workspace.
 *
 *   → "pedro@mogginglabs.com · MoggingLabs"
 */
export function pickIdentity(obj: Record<string, unknown>): string | null {
  const seen = new Set<unknown>()
  let keyedEmail: string | null = null
  let name: string | null = null
  let looseEmail: string | null = null
  let scope: string | null = null

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) walk(item, depth + 1)
      return
    }
    for (const [rawKey, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v.trim()) continue
      const key = rawKey.toLowerCase()
      const val = v.trim()
      if (!keyedEmail && EMAIL_KEYS.has(key) && looksLikeEmail(val)) keyedEmail = val.slice(0, 80)
      if (!name && NAME_KEYS.has(key)) name = val.slice(0, 80)
      if (!looseEmail && looksLikeEmail(val)) looseEmail = val.slice(0, 80)
      if (!scope && SCOPE_KEYS.has(key)) scope = val.slice(0, 40)
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1)
  }
  walk(obj, 0)

  const who = keyedEmail ?? name ?? looseEmail
  if (!who) return scope // a workspace with no user is still better than nothing
  return scope && scope !== who ? `${who} · ${scope}` : who
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 90)
