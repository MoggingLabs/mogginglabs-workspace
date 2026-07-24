// The connections regression suite (ADR 0014) — pure, hermetic, no Electron.
//
//   npm run smoke:connections-pure        (qa-smokes gate: CONNPURE)
//
// A local FIXTURE authorization server + MCP resource drives the REAL client code
// (src/backend/features/integrations/oauth.ts) and the REAL bridge binary
// (bin/mogging-connection.mjs). Nothing here touches the network beyond 127.0.0.1,
// so CI runs it on every push — and every assertion below is regression-shaped:
// each one encodes a bug that actually happened, or a spec obligation that failed
// silently when broken.
//
//   · discovery must FOLLOW the 401's resource_metadata pointer (guessing the
//     origin well-known silently mis-read GitHub's);
//   · a 200 on unauthenticated initialize must NOT mean "no auth" when the preset
//     demands OAuth (Google's servers gate at tool-CALL time — measured);
//   · the scope ask must be the RESOURCE's list, never the AS's (the AS-list
//     default would have asked GitLab for `sudo` and `admin_mode`);
//   · PKCE, code single-use, refresh-token ROTATION, and the merge rule (a rotated
//     token must persist; an omitted one must not erase the previous);
//   · SSE-wrapped responses, session-id enforcement, initialized-before-list order;
//   · the whoami fence (allowlisted name, no required args, never any other tool);
//   · identity: keyed email > display name > loose email, workspace qualifier;
//   · the Bearer→Key scheme fallback (fal.ai), fenced to unauthorized refusals;
//   · the bridge must deliver a reply that was in flight when stdin closed.
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import {
  buildAuthorizeUrl,
  createPkce,
  createState,
  discoverAccount,
  discoverAuthServer,
  exchangeCode,
  fetchAuthServerMetadata,
  lastSseData,
  mcpFetch,
  mergeRefreshedTokens,
  pickIdentity,
  pickScopes,
  probeConnection,
  probeWithSchemes,
  refreshTokens,
  registerClient,
  commitLandedGrant,
  type CommitEffects,
  type ProbeOutcome
} from '@backend/features/integrations'
import {
  connectionEnrichmentPatch,
  enrichmentTargetsSameGrant,
  grantLandedPatch,
  transportLabel,
  type Connection
} from '@contracts'

// ── Harness ──────────────────────────────────────────────────────────────────
const failures: string[] = []
let passes = 0
function check(ok: unknown, name: string): void {
  if (ok) {
    passes++
  } else {
    failures.push(name)
    console.error(`  FAIL  ${name}`)
  }
}
// CI must never hang on a wedged socket: the watchdog loses the race or the suite does.
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: suite exceeded 90s — failing hard')
  process.exit(1)
}, 90_000)

const b64url = (s: Buffer | string): string =>
  (typeof s === 'string' ? Buffer.from(s) : s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256b64url = (s: string): string => b64url(createHash('sha256').update(s).digest())

// ── The fixture: one AS + several MCP resources, all on 127.0.0.1 ───────────
interface FixtureState {
  challenge: string | null
  resourceAtAuthorize: string | null
  codes: Map<string, { verifier: boolean }>
  issuedAccess: Set<string>
  refreshValid: Set<string>
  registration: Record<string, unknown> | null
  initializedSeen: boolean
  toolCalls: Map<string, number>
  bearerAttemptsOnKeyResource: number
}
const S: FixtureState = {
  challenge: null,
  resourceAtAuthorize: null,
  codes: new Map(),
  issuedAccess: new Set(),
  refreshValid: new Set(),
  registration: null,
  initializedSeen: false,
  toolCalls: new Map(),
  bearerAttemptsOnKeyResource: 0
}

const ID_TOKEN = ['{"alg":"none"}', JSON.stringify({ email: 'oidc@fixture.test', name: 'OIDC Person' }), 'sig']
  .map((p, i) => (i === 2 ? p : b64url(p)))
  .join('.')

const TOOLS = [
  { name: 'delete_everything', inputSchema: { required: [] } }, // the trap: never callable by a probe
  { name: 'get_user', inputSchema: { required: ['id'] } }, // whoami-shaped NAME but has required args — fenced out
  { name: 'whoami', inputSchema: {} },
  { name: 'search_issues', inputSchema: {} }
]

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
}
const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

let origin = '' // filled once the fixture is listening

function mcpResource(req: IncomingMessage, res: ServerResponse, body: string, opts: { auth: 'bearer' | 'key' | 'none'; sseList?: boolean; errList?: boolean }): void {
  const authz = String(req.headers.authorization ?? '')
  if (opts.auth === 'bearer') {
    const token = /^Bearer (.+)$/.exec(authz)?.[1]
    if (!token || !S.issuedAccess.has(token)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm/mcp"` }).end()
      return
    }
  }
  if (opts.auth === 'key') {
    if (/^Bearer /.test(authz)) {
      S.bearerAttemptsOnKeyResource++
      res.writeHead(401).end()
      return
    }
    if (authz !== 'Key sk-key-scheme-secret') {
      res.writeHead(401).end()
      return
    }
  }
  let msg: { id?: number; method?: string; params?: { name?: string } }
  try {
    msg = JSON.parse(body)
  } catch {
    sendJson(res, 400, {})
    return
  }
  const sid = String(req.headers['mcp-session-id'] ?? '')
  if (msg.method === 'initialize') {
    sendJson(
      res,
      200,
      { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture-mcp' }, capabilities: { tools: {} } } },
      { 'mcp-session-id': 'sess-1' }
    )
    return
  }
  if (msg.method === 'notifications/initialized') {
    S.initializedSeen = true
    res.writeHead(202).end()
    return
  }
  if (sid !== 'sess-1') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'missing session' } })
    return
  }
  if (msg.method === 'tools/list') {
    if (!S.initializedSeen) {
      sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'initialize first' } })
      return
    }
    if (opts.errList) {
      sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'quota exhausted for this workspace' } })
      return
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    if (opts.sseList) {
      // Streamable HTTP may answer any request as SSE, with progress frames before
      // the result — the client must take the LAST data payload, not the first.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${payload}\n\n`)
      return
    }
    sendJson(res, 200, JSON.parse(payload))
    return
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name ?? '')
    S.toolCalls.set(name, (S.toolCalls.get(name) ?? 0) + 1)
    if (name === 'whoami') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'text',
              // email one level DEEPER than the display name — the exact Notion
              // shape that a first-hit-wins walk got wrong.
              text: JSON.stringify({ user: { name: 'Fixture Person', person: { email: 'pedro@fixture.test' } }, workspace_name: 'FixtureWS' })
            }
          ]
        }
      })
      return
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [] } })
    return
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'unknown method' } })
}

function startFixture(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = req.method === 'POST' ? await readBody(req) : ''

        // ── MCP resources ──
        if (url.pathname === '/mcp') return mcpResource(req, res, body, { auth: 'bearer', sseList: true })
        if (url.pathname === '/key-mcp') return mcpResource(req, res, body, { auth: 'key' })
        if (url.pathname === '/open-mcp') return mcpResource(req, res, body, { auth: 'none' })
        if (url.pathname === '/gated-mcp') return mcpResource(req, res, body, { auth: 'none' }) // Google-style: open initialize, gated tools/call
        if (url.pathname === '/err-mcp') return mcpResource(req, res, body, { auth: 'none', errList: true })

        // ── RFC 9728 protected-resource metadata ──
        // Deliberately NOT at the origin default: /prm/mcp is reachable only via the
        // 401's pointer, so a client that guesses the well-known fails test T1.
        if (url.pathname === '/prm/mcp') {
          return sendJson(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use'] })
        }
        if (url.pathname === '/.well-known/oauth-protected-resource/gated-mcp') {
          return sendJson(res, 200, { resource: `${origin}/gated-mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use'] })
        }
        if (url.pathname === '/.well-known/oauth-protected-resource') return sendJson(res, 404, {})

        // ── RFC 8414, PATH-INSERTED (issuer has a path): only this spelling exists ──
        if (url.pathname === '/.well-known/oauth-authorization-server/as') {
          return sendJson(res, 200, {
            issuer: `${origin}/as`,
            authorization_endpoint: `${origin}/as/authorize`,
            token_endpoint: `${origin}/as/token`,
            registration_endpoint: `${origin}/as/register`,
            code_challenge_methods_supported: ['S256'],
            // The AS offers the WORLD; the resource asked for one scope. The client
            // must ask for the resource's — plus identity — and nothing else.
            scopes_supported: ['mcp:use', 'sudo', 'admin_mode', 'k8s_proxy', 'openid', 'email']
          })
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') return sendJson(res, 404, {})
        if (url.pathname === '/.well-known/openid-configuration') return sendJson(res, 404, {})

        // ── The AS itself ──
        if (url.pathname === '/as/register' && req.method === 'POST') {
          S.registration = JSON.parse(body) as Record<string, unknown>
          return sendJson(res, 201, { client_id: 'client-123' })
        }
        if (url.pathname === '/as/authorize') {
          const q = url.searchParams
          if (q.get('client_id') !== 'client-123' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('resource') || !q.get('state')) {
            return sendJson(res, 400, { error: 'invalid_request' })
          }
          S.challenge = q.get('code_challenge')
          S.resourceAtAuthorize = q.get('resource')
          const code = `code-${randomBytes(6).toString('hex')}`
          S.codes.set(code, { verifier: true })
          res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` }).end()
          return
        }
        if (url.pathname === '/as/token' && req.method === 'POST') {
          const form = new URLSearchParams(body)
          if (form.get('client_id') !== 'client-123') return sendJson(res, 400, { error: 'invalid_client' })
          if (form.get('grant_type') === 'authorization_code') {
            const code = form.get('code') ?? ''
            if (!S.codes.delete(code)) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code already used or unknown' })
            if (sha256b64url(form.get('code_verifier') ?? '') !== S.challenge) {
              return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
            }
            if (form.get('resource') !== `${origin}/mcp`) {
              return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource mismatch' })
            }
            S.issuedAccess.add('at-1')
            S.refreshValid.add('rt-1')
            return sendJson(res, 200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'mcp:use', id_token: ID_TOKEN, token_type: 'bearer' })
          }
          if (form.get('grant_type') === 'refresh_token') {
            const rt = form.get('refresh_token') ?? ''
            if (!S.refreshValid.delete(rt)) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token is not valid (rotated?)' })
            if (rt === 'rt-1') {
              // ROTATION: a new refresh token, and the old one is dead above.
              S.issuedAccess.add('at-2')
              S.refreshValid.add('rt-2')
              return sendJson(res, 200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })
            }
            // Second refresh: NO refresh_token in the response — the merge rule
            // must keep rt-2 rather than persist undefined over it.
            S.issuedAccess.add('at-3')
            S.refreshValid.add('rt-2') // still valid; it was not rotated this time
            return sendJson(res, 200, { access_token: 'at-3', expires_in: 3600 })
          }
          return sendJson(res, 400, { error: 'unsupported_grant_type' })
        }
        sendJson(res, 404, {})
      })()
    })
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve({ close: () => server.close() })
    })
  })
}

// ── Bridge fixture: the app-endpoint socket the bridge dials ────────────────
function startBridgeEndpoint(dir: string): Promise<{ file: string; close: () => void; server: NetServer }> {
  const address =
    process.platform === 'win32' ? `\\\\.\\pipe\\connpure-${process.pid}-${Date.now().toString(36)}` : join(dir, 'endpoint.sock')
  return new Promise((resolve) => {
    const server = createNetServer((sock) => {
      sock.setEncoding('utf8')
      let buf = ''
      sock.on('data', (chunk: string) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (!line) continue
          const msg = JSON.parse(line) as { t?: string; token?: string; id?: number; name?: string; args?: { connection?: string; payload?: { id?: number } } }
          if (msg.t === 'hello') {
            sock.write(msg.token === 'fixture-token' ? '{"t":"welcome"}\n' : '{"t":"error","reason":"auth"}\n')
            continue
          }
          if (msg.t === 'call' && msg.name === 'connection.rpc') {
            const conn = msg.args?.connection
            if (conn === 'down-svc') {
              sock.write(JSON.stringify({ t: 'result', id: msg.id, ok: false, reason: 'The down-svc connection is not connected in MoggingLabs Workspace — open Settings › Integrations and connect it.' }) + '\n')
              continue
            }
            // DELAYED reply: the whole point — the bridge's stdin will already be
            // closed when this arrives, and the reply must still be delivered.
            const reply = JSON.stringify({ t: 'result', id: msg.id, ok: true, payload: { jsonrpc: '2.0', id: msg.args?.payload?.id, result: { echoed: true } } }) + '\n'
            setTimeout(() => sock.write(reply), 150)
          }
        }
      })
    })
    server.listen(address, () => {
      const file = join(dir, 'browser-control.json')
      writeFileSync(file, JSON.stringify({ version: 8, address, token: 'fixture-token' }))
      resolve({ file, close: () => server.close(), server })
    })
  })
}

function runBridge(endpointFile: string, connection: string, frame: unknown): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'bin', 'mogging-connection.mjs'), '--connection', connection], {
      env: { ...process.env, MOGGING_BROWSER_ENDPOINT: endpointFile },
      windowsHide: true
    })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ stdout, code: null })
    }, 8000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ stdout, code })
    })
    // Write ONE frame and close stdin immediately — the in-flight regression.
    child.stdin.end(JSON.stringify(frame) + '\n')
  })
}

// ── The suite ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const fixture = await startFixture()
  const mcpUrl = `${origin}/mcp`

  // T1 — discovery FOLLOWS the pointer (the PRM lives at /prm/mcp, unreachable by guessing)
  const disco = await discoverAuthServer(mcpUrl)
  check(disco.ok, 'T1 discovery succeeds via the WWW-Authenticate pointer')
  if (!disco.ok) throw new Error('cannot continue without discovery')
  check(disco.metadata.issuer === `${origin}/as`, 'T1 authorization server resolved from resource metadata')
  check(JSON.stringify(disco.resourceScopes) === '["mcp:use"]', 'T1 resource scopes surfaced from the PRM')
  const rootPrm = await fetch(`${origin}/.well-known/oauth-protected-resource`).then((r) => r.status)
  check(rootPrm === 404, 'T1 origin-default PRM really is absent (the pointer was the only road)')

  // T1b — RFC 8414 path-inserted metadata was the spelling that worked
  check((await fetchAuthServerMetadata(`${origin}/as`))?.token_endpoint === `${origin}/as/token`, 'T1b path-aware AS metadata resolution')

  // T2 — a 200 on unauthenticated initialize
  const open = await discoverAuthServer(`${origin}/open-mcp`)
  check(!open.ok && open.noAuthNeeded === true, 'T2 open server → noAuthNeeded (local connection)')
  const openStrict = await discoverAuthServer(`${origin}/open-mcp`, { requireAuth: true })
  check(!openStrict.ok && !openStrict.noAuthNeeded && /advertises no way to sign in/.test(openStrict.reason), 'T2 requireAuth refuses an un-gated server with the honest sentence')
  const gated = await discoverAuthServer(`${origin}/gated-mcp`, { requireAuth: true })
  check(gated.ok && gated.metadata.issuer === `${origin}/as`, 'T2 Google-style server (200 initialize, PRM at well-known) still finds its AS under requireAuth')

  // T3 — the scope ask is the RESOURCE's, plus identity, and NEVER the AS's world
  const asked = pickScopes(disco.resourceScopes, disco.metadata)
  check(JSON.stringify(asked) === '["mcp:use","openid","email"]', 'T3 asks resource scopes + identity only')
  check(!asked.includes('sudo') && !asked.includes('admin_mode') && !asked.includes('k8s_proxy'), 'T3 never asks for the AS platform scopes (sudo/admin/k8s)')

  // T4 — dynamic client registration, as a PUBLIC client
  const reg = await registerClient(disco.metadata, 'http://127.0.0.1:39999/callback')
  check(reg.ok && reg.client.clientId === 'client-123', 'T4 DCR returns the client id')
  check(S.registration?.token_endpoint_auth_method === 'none', 'T4 registered as a public client (no secret to ship)')
  check(Array.isArray(S.registration?.grant_types) && (S.registration!.grant_types as string[]).includes('refresh_token'), 'T4 registration requests the refresh grant')
  if (!reg.ok) throw new Error('cannot continue without a client')

  // T5 — authorize → code → PKCE-verified exchange
  const pkce = createPkce()
  const state = createState()
  const authUrl = buildAuthorizeUrl({ metadata: disco.metadata, clientId: reg.client.clientId, redirectUri: 'http://127.0.0.1:39999/callback', resource: disco.resource, challenge: pkce.challenge, state, scopes: asked })
  const authRes = await fetch(authUrl, { redirect: 'manual' })
  const location = authRes.headers.get('location') ?? ''
  const code = new URL(location).searchParams.get('code') ?? ''
  check(authRes.status === 302 && !!code && location.includes(`state=${state}`), 'T5 authorize round trip issues a code bound to our state')
  check(S.resourceAtAuthorize === disco.resource, 'T5 resource (RFC 8707) rode the authorize request')
  const badExchange = await exchangeCode(disco.metadata, reg.client, { code: 'code-nonexistent', verifier: pkce.verifier, redirectUri: 'http://127.0.0.1:39999/callback', resource: disco.resource })
  check(!badExchange.ok && /already used or unknown/.test(badExchange.reason), 'T5 a bogus code is refused with the AS reason surfaced')
  const wrongVerifier = await exchangeCode(disco.metadata, reg.client, { code, verifier: 'not-the-verifier-not-the-verifier-not-the-verifier', redirectUri: 'http://127.0.0.1:39999/callback', resource: disco.resource })
  check(!wrongVerifier.ok, 'T5 a wrong PKCE verifier is refused')
  check(!S.codes.has(code), 'T5 the code is single-use (burned by the failed exchange)')
  // Re-authorize for the real exchange (the fixture burned the first code).
  const authRes2 = await fetch(buildAuthorizeUrl({ metadata: disco.metadata, clientId: reg.client.clientId, redirectUri: 'http://127.0.0.1:39999/callback', resource: disco.resource, challenge: pkce.challenge, state, scopes: asked }), { redirect: 'manual' })
  const code2 = new URL(authRes2.headers.get('location') ?? 'http://x/?').searchParams.get('code') ?? ''
  const exchanged = await exchangeCode(disco.metadata, reg.client, { code: code2, verifier: pkce.verifier, redirectUri: 'http://127.0.0.1:39999/callback', resource: disco.resource })
  check(exchanged.ok && exchanged.tokens.accessToken === 'at-1' && exchanged.tokens.refreshToken === 'rt-1', 'T5 PKCE-proven exchange lands tokens')
  check(exchanged.ok && (await discoverAccount(exchanged.tokens, disco.metadata)) === 'oidc@fixture.test', 'T5 the id_token email names the account')

  // T6 — refresh rotation + the merge rule
  const r1 = await refreshTokens(disco.metadata, reg.client, { refreshToken: 'rt-1', resource: disco.resource })
  check(r1.ok && r1.tokens.accessToken === 'at-2' && r1.tokens.refreshToken === 'rt-2', 'T6 refresh rotates the refresh token')
  const replay = await refreshTokens(disco.metadata, reg.client, { refreshToken: 'rt-1', resource: disco.resource })
  check(!replay.ok && /not valid/.test(replay.reason), 'T6 the rotated-away token is dead (single-use)')
  const r2 = await refreshTokens(disco.metadata, reg.client, { refreshToken: 'rt-2', resource: disco.resource })
  check(r2.ok && r2.tokens.accessToken === 'at-3' && r2.tokens.refreshToken === undefined, 'T6 second refresh omits the refresh token (many providers do)')
  if (r1.ok && r2.ok) {
    const merged = mergeRefreshedTokens(r1.tokens, r2.tokens)
    check(merged.refreshToken === 'rt-2' && merged.accessToken === 'at-3', 'T6 merge keeps the surviving refresh token instead of erasing it')
  }

  // T7 — the probe: SSE list, session enforcement, initialized-first, whoami fence, identity
  const probe = await probeConnection(mcpUrl, 'at-2')
  check(probe.ok, `T7 probe succeeds (${probe.ok ? 'ok' : probe.reason})`)
  if (probe.ok) {
    check(probe.probe.serverName === 'fixture-mcp', 'T7 server name from initialize')
    check(probe.probe.toolCount === TOOLS.length, 'T7 tool count from an SSE-wrapped tools/list')
    check(JSON.stringify(probe.probe.tools) === JSON.stringify(TOOLS.map((t) => t.name)), 'T7 tool NAMES surfaced (full observability)')
    check(probe.probe.account === 'pedro@fixture.test · FixtureWS', 'T7 whoami email preferred over display name, workspace-qualified')
  }
  check(S.initializedSeen, 'T7 notifications/initialized was sent before tools/list')
  check((S.toolCalls.get('whoami') ?? 0) === 1, 'T7 whoami called exactly once')
  check((S.toolCalls.get('delete_everything') ?? 0) === 0, 'T7 the fence: no non-allowlisted tool was ever called')
  check((S.toolCalls.get('get_user') ?? 0) === 0, 'T7 the fence: an allowlist-named tool WITH required args is not called')

  // T8 — a server that refuses IN-BAND (JSON-RPC error, HTTP 200) surfaces its own words
  const errProbe = await probeConnection(`${origin}/err-mcp`)
  check(!errProbe.ok && /quota exhausted/.test(errProbe.reason), 'T8 JSON-RPC envelope errors surface the server sentence')

  // T9 — a bad token reads as unauthorized, not as a mystery
  const badProbe = await probeConnection(mcpUrl, 'bad-token')
  check(!badProbe.ok && badProbe.unauthorized === true, 'T9 401 → unauthorized')

  // T10 — the Bearer→Key scheme fallback, fenced to unauthorized refusals
  const schemes = await probeWithSchemes(`${origin}/key-mcp`, 'sk-key-scheme-secret')
  check(schemes.ok && schemes.authScheme === 'Key', 'T10 Key-scheme server connects via the fallback')
  check(S.bearerAttemptsOnKeyResource === 1, 'T10 Bearer was tried first, exactly once')

  // T11 — identity mining, the table of real provider shapes
  const idCases: Array<[string, Record<string, unknown>, string | null]> = [
    ['notion nested email', { workspace_name: 'MoggingLabs', owner: { user: { name: 'Pedro Veloso', person: { email: 'pedro@mogginglabs.com' } } } }, 'pedro@mogginglabs.com · MoggingLabs'],
    ['github whoami flat', { login: 'pedrovel', name: 'Pedro Veloso', email: 'pedro@mogginglabs.com' }, 'pedro@mogginglabs.com'],
    ['slack team only', { team: { id: 'T1', name: 'MoggingLabs' }, authed_user: { id: 'U1' } }, 'MoggingLabs'],
    ['billing-email trap', { user: { name: 'Pedro Veloso' }, billing_email: 'accounts@vendor.com' }, 'Pedro Veloso'],
    ['microsoft mail key', { displayName: 'Pedro Veloso', mail: 'pedro@mogginglabs.com' }, 'pedro@mogginglabs.com'],
    ['opaque only', { stripe_user_id: 'acct_1234', livemode: false }, null]
  ]
  for (const [name, payload, expected] of idCases) {
    check(pickIdentity(payload) === expected, `T11 identity: ${name}`)
  }

  // T12 — SSE parsing takes the LAST data frame, multi-line joined
  check(lastSseData('data: {"a":1}\n\ndata: part1\ndata: part2\n\n') === 'part1\npart2', 'T12 lastSseData: last frame, multi-line joined')

  // T13 — a notification (202, empty body) is ok:null, not an error
  const notif = await mcpFetch(mcpUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token: 'at-2' })
  check(notif.ok && notif.result === null, 'T13 notification round trip (202/empty) is not an error')

  // T14 — the REAL bridge binary against a fixture endpoint socket
  const dir = mkdtempSync(join(tmpdir(), 'connpure-'))
  const ep = await startBridgeEndpoint(dir)
  const okRun = await runBridge(ep.file, 'ok-svc', { jsonrpc: '2.0', id: 7, method: 'tools/list' })
  check(/"echoed":true/.test(okRun.stdout) && /"id":7/.test(okRun.stdout), 'T14 bridge forwards and delivers the server envelope verbatim')
  check(okRun.code === 0, 'T14 bridge exits 0 after delivering an in-flight reply past stdin close')
  const downRun = await runBridge(ep.file, 'down-svc', { jsonrpc: '2.0', id: 9, method: 'tools/list' })
  check(/Settings › Integrations/.test(downRun.stdout) && /"error"/.test(downRun.stdout), 'T14 a not-connected service answers with an actionable JSON-RPC error')
  const deadRun = await runBridge(join(dir, 'nonexistent.json'), 'ok-svc', { jsonrpc: '2.0', id: 3, method: 'tools/list' })
  check(/not running/.test(deadRun.stdout), 'T14 app-not-running answers with the honest sentence')
  ep.close()
  rmSync(dir, { recursive: true, force: true })

  // T15 — the two-phase connect: CONNECTED is proven by the grant, enrichment only fills.
  // Each assertion below is the bug it prevents: a card stuck "connecting…" behind the
  // probe, a valid grant demoted to "error", a Cancel overwritten by a late probe write.
  const landed = grantLandedPatch({ scopes: ['mcp:use'], expiresAt: 123, connectedAt: 1000, authServer: `${origin}/as`, userClient: false })
  check(landed.state === 'connected', 'T15 grant landing sets connected from the grant alone')
  check(!('account' in landed) && !('tools' in landed) && !('toolCount' in landed) && !('serverName' in landed), 'T15 connected does NOT depend on any probe field (no account/tools/count/name in the landing patch)')
  check(landed.needsClientId === undefined && landed.lastError === undefined && landed.userClient === undefined, 'T15 a landed grant clears the prerequisite flag, the error, and a false userClient')
  check(grantLandedPatch({ connectedAt: 1, authServer: 'x', userClient: true, scopes: [] }).userClient === true, 'T15 a user-pasted client is remembered on the landed grant')

  // The enrichment patch never carries state, and a failed/empty probe leaves the card as-is.
  const good = connectionEnrichmentPatch({ account: 'pedro@fixture.test', serverName: 'fixture-mcp', toolCount: 4, tools: ['a', 'b'] })
  check(!('state' in good) && good.account === 'pedro@fixture.test' && good.toolCount === 4, 'T15 enrichment fills account/tools and NEVER carries state')
  const empty = connectionEnrichmentPatch({ account: null, serverName: undefined, toolCount: undefined, tools: undefined })
  check(Object.keys(empty).length === 0, 'T15 a probe that answered nothing writes nothing (no blanks over a shown value)')
  check(connectionEnrichmentPatch({ toolCount: 0 }).toolCount === 0, 'T15 a real zero tool count is kept (undefined-guard, not falsy-guard)')
  // Merged, the two phases are: disconnected -> connected -> connected (enrichment can't undo it).
  const base: Connection = { id: 'x', label: 'X', authKind: 'oauth', state: 'disconnected' }
  const afterLand = { ...base, ...landed } as Connection
  check(afterLand.state === 'connected', 'T15 phase-1 merge takes a disconnected card to connected')
  check(({ ...afterLand, ...empty } as Connection).state === 'connected', 'T15 phase-2 merge over a failed probe stays connected')

  // The stamp guard: only the SAME landed grant is enriched — a disconnect or reconnect drops the stale write.
  check(enrichmentTargetsSameGrant(afterLand, 1000), 'T15 enrichment applies to the grant it was started for')
  check(!enrichmentTargetsSameGrant({ ...afterLand, connectedAt: 2000 } as Connection, 1000), 'T15 a reconnect (new stamp) drops the stale enrichment')
  check(!enrichmentTargetsSameGrant({ ...afterLand, state: 'disconnected' } as Connection, 1000), 'T15 a disconnect during enrichment drops the stale write')
  check(!enrichmentTargetsSameGrant(null, 1000), 'T15 a card gone from the store is not re-minted by a late probe')

  // T16 — the transport tag reflects the ENDPOINT scheme, not the ambiguous "http" keyword.
  check(transportLabel({ transport: 'http', url: 'https://mcp.vercel.com' }) === 'HTTPS', 'T16 an https endpoint reads as HTTPS, not http')
  check(transportLabel({ transport: 'http', url: 'http://127.0.0.1:7777/mcp' }) === 'HTTP · localhost', 'T16 a loopback http endpoint is named honestly as localhost http')
  check(transportLabel({ transport: 'stdio', url: undefined }) === 'stdio', 'T16 stdio (a local subprocess) stands — it reads as no scheme')
  check(transportLabel({ transport: 'http', url: undefined }) === 'HTTP', 'T16 a urless http row falls back to the bare transport')

  // T17 — the connect ORCHESTRATION, driven hermetically through the REAL two-phase code
  // (src/backend/features/integrations/connect-orchestrator.ts — the same function main
  // calls). T15 proved the patch builders; this proves onCallback assembles them in the
  // order that fixes stuck-connecting, the cancel race, and the probe-downgrade.
  const mkFx = (over: {
    probeResult?: ProbeOutcome
    account?: string | null
    frozenState?: Connection | null // when set, readState always returns this (mid-flight change)
  }): { fx: CommitEffects; events: string[]; patches: Partial<Connection>[] } => {
    const events: string[] = []
    const patches: Partial<Connection>[] = []
    let cur: Connection = { id: 'x', label: 'X', authKind: 'oauth', state: 'disconnected' }
    const fx: CommitEffects = {
      setState: (p) => {
        events.push('setState:' + (p.state ?? 'enrich'))
        patches.push(p)
        cur = { ...cur, ...p }
      },
      readState: () => (over.frozenState !== undefined ? over.frozenState : cur),
      registerServer: () => events.push('register'),
      closeFlow: () => events.push('close'),
      showPage: () => events.push('page'),
      discoverAccount: async () => {
        events.push('discover')
        return over.account ?? null
      },
      probe: async () => {
        events.push('probe')
        return over.probeResult ?? { ok: true, probe: { serverName: 'fixture-mcp', toolCount: 4, tools: ['a', 'b', 'c', 'd'], account: 'pedro@fixture.test' } }
      },
      now: () => 1000
    }
    return { fx, events, patches }
  }

  const happy = mkFx({})
  await commitLandedGrant(happy.fx, { label: 'Drive', authServer: 'https://accounts.google.com', userClient: false, scopes: ['mcp:use'] })
  check(happy.events[0] === 'setState:connected', 'T17 the FIRST effect is the connected write — no probe gates it (kills stuck-connecting)')
  check(happy.events.indexOf('close') < happy.events.indexOf('probe'), 'T17 the flow is CLOSED before enrichment — a late Cancel finds no pending flow')
  check(happy.events.indexOf('register') >= 0 && happy.events.indexOf('register') < happy.events.indexOf('probe'), 'T17 the CLI bridge registers on the grant, not on the probe')
  check(happy.events[happy.events.length - 1] === 'setState:enrich' && happy.patches[happy.patches.length - 1].account === 'pedro@fixture.test', 'T17 enrichment fills the account LAST, over a second push')

  const failed = mkFx({ probeResult: { ok: false, reason: 'quota exhausted for this workspace' } })
  await commitLandedGrant(failed.fx, { label: 'X', authServer: 'iss', userClient: false })
  check(!failed.patches.some((p) => p.state === 'error' || p.state === 'expired'), 'T17 a non-unauthorized probe failure NEVER downgrades a landed grant (kills error-over-valid-grant)')

  const refused = mkFx({ probeResult: { ok: false, reason: 'nope', unauthorized: true } })
  await commitLandedGrant(refused.fx, { label: 'X', authServer: 'iss', userClient: false })
  check(refused.patches.some((p) => p.state === 'expired'), 'T17 an unauthorized resource DOES downgrade — to expired, the one honest reconnect signal')

  const moved = mkFx({ frozenState: { id: 'x', label: 'X', authKind: 'oauth', state: 'disconnected' } })
  await commitLandedGrant(moved.fx, { label: 'X', authServer: 'iss', userClient: false })
  check(!moved.patches.slice(1).some((p) => 'account' in p || p.state === 'expired'), 'T17 a disconnect during enrichment drops the stale write (stamp guard)')

  const thrown = mkFx({})
  thrown.fx.probe = async (): Promise<ProbeOutcome> => {
    throw new Error('socket reset mid-probe')
  }
  let escaped = false
  try {
    await commitLandedGrant(thrown.fx, { label: 'X', authServer: 'iss', userClient: false })
  } catch {
    escaped = true
  }
  check(!escaped && thrown.events.includes('close'), 'T17 a thrown probe never escapes — the connection was already committed')

  fixture.close()
  clearTimeout(watchdog)
  console.log(`\nconnections-pure: ${passes} passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('FAILED:\n' + failures.map((f) => `  · ${f}`).join('\n'))
    process.exit(1)
  }
}

void main().catch((e) => {
  console.error('SUITE ERROR:', e)
  process.exit(1)
})
