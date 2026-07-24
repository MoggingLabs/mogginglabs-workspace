import { app, shell, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpPreset } from '@contracts'
import { MCP_PRESETS } from '@backend/features/integrations'
import { connect, disconnect, cancelConnect, listConnections } from '../connections'

// Env-gated LIVE connect smoke (MOGGING_CONNLIVE). This boots the REAL app and drives the
// REAL connect()/onCallback against a local fixture authorization server — the one thing
// CONNPURE (pure) cannot do: prove the ORCHESTRATION in a real Electron runtime, end to end.
//
// It is the live counterpart to CONNPURE's T17. The fixture's tools/list is DELIBERATELY
// SLOW (2.5s), so the assertions can catch the bug this whole change exists to kill:
//
//   (a) IMMEDIACY  — the card reads `connected` the instant the grant lands, while the
//       slow probe is still in flight (toolCount still absent). The old flow sat on
//       "connecting…" for the length of that probe.
//   (b) ENRICHMENT — the account and the 8 tools fill in over a SECOND push once the
//       probe returns; connectedness never depended on it.
//   (c) CANCEL     — a Cancel that lands after the grant is a no-op on a live connection
//       (the flow is already closed; a landed grant stands).
//   (d) NO DOWNGRADE — a probe that FAILS (non-unauthorized) leaves the card connected
//       with no tool list, never "error".
//
// Zero external network: the fixture, the AS, and the loopback callback are all 127.0.0.1.
// shell.openExternal is monkeypatched to DRIVE the loopback (fetch authorize → callback)
// instead of opening a browser, so no consent UI and no real credentials are involved.

const b64url = (s: Buffer | string): string =>
  (typeof s === 'string' ? Buffer.from(s) : s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256b64url = (s: string): string => b64url(createHash('sha256').update(s).digest())
const ID_TOKEN = ['{"alg":"none"}', JSON.stringify({ email: 'connlive@fixture.test', name: 'ConnLive Person' }), 'sig']
  .map((p, i) => (i === 2 ? p : b64url(p)))
  .join('.')
const TOOLS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
const SLOW_LIST_MS = 2500

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

let origin = ''
const S = { challenge: null as string | null }

// One MCP resource handler, parameterised by how tools/list behaves.
function mcpResource(req: IncomingMessage, res: ServerResponse, body: string, mode: 'slow' | 'err'): void {
  const authz = String(req.headers.authorization ?? '')
  const token = /^Bearer (.+)$/.exec(authz)?.[1]
  if (!token) {
    res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm/${mode}"` }).end()
    return
  }
  let msg: { id?: number; method?: string }
  try {
    msg = JSON.parse(body)
  } catch {
    sendJson(res, 400, {})
    return
  }
  if (msg.method === 'initialize') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'ConnLiveFixture' }, capabilities: { tools: {} } } }, { 'mcp-session-id': 'sess-1' })
    return
  }
  if (msg.method === 'notifications/initialized') {
    res.writeHead(202).end()
    return
  }
  if (msg.method === 'tools/list') {
    if (mode === 'err') {
      sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'quota exhausted for this workspace' } })
      return
    }
    // SLOW on purpose — this is the window the immediacy assertion measures against.
    setTimeout(() => {
      sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((name) => ({ name, inputSchema: {} })) } })
    }, SLOW_LIST_MS)
    return
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result: { content: [] } })
}

function startFixture(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = req.method === 'POST' ? await readBody(req) : ''
        const p = url.pathname

        if (p === '/mcp') return mcpResource(req, res, body, 'slow')
        if (p === '/err-mcp') return mcpResource(req, res, body, 'err')
        if (p === '/prm/slow') return sendJson(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use'] })
        if (p === '/prm/err') return sendJson(res, 200, { resource: `${origin}/err-mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use'] })
        if (p === '/.well-known/oauth-authorization-server/as') {
          return sendJson(res, 200, {
            issuer: `${origin}/as`,
            authorization_endpoint: `${origin}/as/authorize`,
            token_endpoint: `${origin}/as/token`,
            registration_endpoint: `${origin}/as/register`,
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['mcp:use', 'openid', 'email']
          })
        }
        if (p === '/as/register' && req.method === 'POST') return sendJson(res, 201, { client_id: 'client-123' })
        if (p === '/as/authorize') {
          const q = url.searchParams
          if (q.get('client_id') !== 'client-123' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('resource') || !q.get('state')) {
            return sendJson(res, 400, { error: 'invalid_request' })
          }
          S.challenge = q.get('code_challenge')
          const code = `code-${randomBytes(6).toString('hex')}`
          res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` }).end()
          return
        }
        if (p === '/as/token' && req.method === 'POST') {
          const form = new URLSearchParams(body)
          if (form.get('client_id') !== 'client-123') return sendJson(res, 400, { error: 'invalid_client' })
          if (sha256b64url(form.get('code_verifier') ?? '') !== S.challenge) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE failed' })
          const resource = form.get('resource') ?? ''
          if (resource !== `${origin}/mcp` && resource !== `${origin}/err-mcp`) return sendJson(res, 400, { error: 'invalid_target' })
          return sendJson(res, 200, { access_token: `at-${randomBytes(4).toString('hex')}`, refresh_token: 'rt-1', expires_in: 3600, scope: 'mcp:use', id_token: ID_TOKEN, token_type: 'bearer' })
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

export function runConnLiveSmoke(_win: BrowserWindow): void {
  const safety = setTimeout(() => app.exit(1), 120000)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const stateOf = (id: string) => listConnections().find((c) => c.id === id)
  let result: Record<string, unknown> = { pass: false }
  let fixture: { close: () => void } | null = null

  // Drive the loopback in place of a real browser: fetch the authorize URL (fixture 302s
  // to our own 127.0.0.1 callback), then fetch that callback — which lands in onCallback.
  // The callback fetch RESOLVES when phase 1 has sent its success page, i.e. after the
  // grant is committed connected but BEFORE the slow probe — exactly the window we test.
  const origOpen = shell.openExternal.bind(shell)
  shell.openExternal = async (authorizeUrl: string): Promise<void> => {
    const loc = (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location')
    if (loc) await fetch(loc)
  }

  const run = async (): Promise<void> => {
    try {
      fixture = await startFixture()
      const mk = (id: string, path: string): McpPreset => ({
        id,
        label: id,
        transport: 'http',
        urlOrCommand: `${origin}${path}`,
        authKinds: ['oauth'],
        envRefSlots: [],
        cliQuirks: {},
        grantCopy: 'Fixture connection for the CONNLIVE gate.',
        verifiedAt: '2026-07-20'
      })
      // Inject two fixture presets so connect() can resolve them (test-only, in the smoke —
      // production MCP_PRESETS is untouched; readonly is a compile-time type, not a freeze).
      ;(MCP_PRESETS as McpPreset[]).push(mk('connlive-ok', '/mcp'), mk('connlive-err', '/err-mcp'))

      // ── Scenario 1: immediacy + cancel-no-op + enrichment ──────────────────
      const r1 = await connect('connlive-ok')
      const immediate = stateOf('connlive-ok')
      // (a) connected the instant the grant landed, while the 2.5s probe is still out.
      const immediacyOk = r1.ok && immediate?.state === 'connected' && immediate?.toolCount == null
      // (c) a Cancel now is a no-op — the flow is closed, the grant stands.
      cancelConnect('connlive-ok')
      const afterCancel = stateOf('connlive-ok')
      const cancelNoopOk = afterCancel?.state === 'connected'
      // (b) the probe returns; account + tools fill in over the second push.
      await sleep(SLOW_LIST_MS + 1500)
      const enriched = stateOf('connlive-ok')
      const enrichOk = enriched?.state === 'connected' && enriched?.toolCount === TOOLS.length && (enriched?.tools?.length ?? 0) === TOOLS.length
      const accountOk = enriched?.account === 'connlive@fixture.test'

      disconnect('connlive-ok')
      await sleep(300)

      // ── Scenario 2: a failing probe never downgrades a landed grant ────────
      const r2 = await connect('connlive-err')
      await sleep(1500) // let the (fast) error probe resolve
      const errState = stateOf('connlive-err')
      const noDowngradeOk = r2.ok && errState?.state === 'connected' && errState?.toolCount == null
      disconnect('connlive-err')

      result = {
        pass: immediacyOk && cancelNoopOk && enrichOk && accountOk && noDowngradeOk,
        immediacyOk,
        cancelNoopOk,
        enrichOk,
        accountOk,
        noDowngradeOk,
        observed: {
          immediateState: immediate?.state,
          immediateToolCount: immediate?.toolCount ?? null,
          afterCancelState: afterCancel?.state,
          enrichedState: enriched?.state,
          enrichedToolCount: enriched?.toolCount ?? null,
          enrichedAccount: enriched?.account ?? null,
          errState: errState?.state,
          errToolCount: errState?.toolCount ?? null
        }
      }
    } catch (e) {
      result = { pass: false, error: String(e) }
    }
    shell.openExternal = origOpen
    try {
      fixture?.close()
    } catch {
      /* already closing */
    }
    try {
      writeFileSync(join(process.cwd(), 'out', 'connlive-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  setTimeout(() => void run(), 3000)
}
