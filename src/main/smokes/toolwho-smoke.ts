import { app, shell, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpPreset, ProviderEntry } from '@contracts'
import { connectionIdentityRow } from '@contracts'
import { MCP_PRESETS, injectProviderEntryForSmoke } from '@backend/features/integrations'
import { connect, submitKey, disconnect, listConnections, verifyConnection } from '../connections'

// Env-gated LIVE identity smoke (MOGGING_TOOLWHO, phase-tools/04). Boots the REAL app
// and drives the catalog-driven identity ladder against local fixtures — zero external
// network, zero real accounts.
//
//   (a) OIDC     — a full PKCE connect whose token response carries an id_token; the
//       first verify lands {email} with accountSource 'oidc' from claims in hand.
//   (b) REST     — a key service whose injected catalog `profile` names /rest-user
//       with paths (email mapped from `contact`, name from `profile.name`): the
//       fixture asserts the EXACT endpoint was hit, and the mapped fields prove the
//       catalog paths drove the read (a generic walk cannot find `contact`).
//   (c) TOOL     — a server listing `get_me` gets exactly ONE whoami call and lands
//       accountSource 'tool'; a server listing only `do_thing` gets ZERO calls.
//   (d) FALLBACK + NOTE — an identity-less card renders the honest fallback +
//       "Add a note…"; a note set over IPC survives disconnect/reconnect; probed and
//       noted render as DISTINCT DOM classes, probed winning when both exist.
//   (e) STABILITY — once identity landed, the next verify spends ZERO identity calls
//       (no REST re-fetch, no whoami re-ask): an identity once probed is stable.
//
// MUTATION-RED ×2, proven LIVE on every pass:
//   · MOGGING_WHO_BREAK_ALLOWLIST — a broken tool-allowlist match makes the no-whoami
//     fixture receive a call, which is exactly what (c)'s zero-call assert catches;
//   · connectionIdentityRow's `_testNotedBeatsProbed` — inverted precedence makes the
//     noted text win a probed card, which is exactly what (d)'s DOM assert catches.

const b64url = (s: Buffer | string): string =>
  (typeof s === 'string' ? Buffer.from(s) : s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256b64url = (s: string): string => b64url(createHash('sha256').update(s).digest())
const ID_TOKEN = ['{"alg":"none"}', JSON.stringify({ sub: 'u-oidc-1', email: 'who@fixture.test', name: 'Who Person' }), 'sig']
  .map((p, i) => (i === 2 ? p : b64url(p)))
  .join('.')

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

interface FixtureState {
  restUserHits: number
  restUserPaths: string[]
  toolCalls: Map<string, { count: number; names: string[] }>
}

let origin = ''
const S = { challenge: null as string | null }

/** One MCP resource handler: optional bearer key, a fixed tools/list, and a
 *  canned tools/call answer per service. */
function mcpResource(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  svc: { key?: string; tools: string[]; whoamiAnswer?: unknown },
  state: FixtureState,
  id: string
): void {
  if (svc.key) {
    if (String(req.headers.authorization ?? '') !== `Bearer ${svc.key}`) {
      res.writeHead(401).end()
      return
    }
  } else {
    // The OIDC resource: any bearer token minted by the fixture AS is accepted.
    if (!/^Bearer .+/.test(String(req.headers.authorization ?? ''))) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm"` }).end()
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
  if (msg.method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: `Who-${id}` }, capabilities: { tools: {} } }
    })
    return
  }
  if (msg.method === 'notifications/initialized') {
    res.writeHead(202).end()
    return
  }
  if (msg.method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: svc.tools.map((name) => ({ name, inputSchema: {} })) } })
    return
  }
  if (msg.method === 'tools/call') {
    const rec = state.toolCalls.get(id) ?? { count: 0, names: [] }
    rec.count += 1
    rec.names.push(String(msg.params?.name ?? ''))
    state.toolCalls.set(id, rec)
    const answer = svc.whoamiAnswer ?? { status: 'ok' }
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify(answer) }] }
    })
    return
  }
  sendJson(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result: { content: [] } })
}

function startFixture(state: FixtureState): Promise<{ close: () => void }> {
  const SVCS: Record<string, { key?: string; tools: string[]; whoamiAnswer?: unknown }> = {
    'oidc-mcp': { tools: ['list_things'] },
    'rest-mcp': { key: 'key-rest', tools: ['list_things'] },
    'tool-mcp': { key: 'key-tool', tools: ['get_me', 'list_things'], whoamiAnswer: { id: 't1', email: 'tool@fixture.test' } },
    'none-mcp': { key: 'key-none', tools: ['do_thing'] }
  }
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = req.method === 'POST' ? await readBody(req) : ''
        const p = url.pathname

        // (b): the provider's own identity endpoint — the catalog names THIS path.
        if (p === '/rest-user') {
          state.restUserHits += 1
          state.restUserPaths.push(p)
          if (String(req.headers.authorization ?? '') !== 'Bearer key-rest') return sendJson(res, 401, {})
          return sendJson(res, 200, { uid: 7, contact: 'rest@fixture.test', profile: { name: 'Rest Person' } })
        }

        const svc = /^\/([a-z]+-mcp)$/.exec(p)?.[1]
        if (svc && SVCS[svc]) return mcpResource(req, res, body, SVCS[svc], state, svc)

        // The fixture AS (the CONNLIVE shape): PRM + metadata + register + authorize + token.
        if (p === '/prm') return sendJson(res, 200, { resource: `${origin}/oidc-mcp`, authorization_servers: [`${origin}/as`], scopes_supported: ['mcp:use'] })
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
        if (p === '/as/register' && req.method === 'POST') return sendJson(res, 201, { client_id: 'client-who' })
        if (p === '/as/authorize') {
          const q = url.searchParams
          if (q.get('client_id') !== 'client-who' || !q.get('code_challenge') || !q.get('state')) return sendJson(res, 400, { error: 'invalid_request' })
          S.challenge = q.get('code_challenge')
          res.writeHead(302, { location: `${q.get('redirect_uri')}?code=code-${randomBytes(6).toString('hex')}&state=${q.get('state')}` }).end()
          return
        }
        if (p === '/as/token' && req.method === 'POST') {
          const form = new URLSearchParams(body)
          if (form.get('client_id') !== 'client-who') return sendJson(res, 400, { error: 'invalid_client' })
          if (sha256b64url(form.get('code_verifier') ?? '') !== S.challenge) return sendJson(res, 400, { error: 'invalid_grant' })
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

export function runToolWhoSmoke(win: BrowserWindow): void {
  const safety = setTimeout(() => app.exit(1), 220000)
  const wc = win.webContents
  const ES = <T = unknown>(js: string): Promise<T> => wc.executeJavaScript(js, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const stateOf = (id: string) => listConnections().find((c) => c.id === id)

  const state: FixtureState = { restUserHits: 0, restUserPaths: [], toolCalls: new Map() }
  const calls = (id: string): number => state.toolCalls.get(id)?.count ?? 0

  let result: Record<string, unknown> = { pass: false }
  let fixture: { close: () => void } | null = null

  // Drive the loopback in place of a real browser (the CONNLIVE shape).
  const origOpen = shell.openExternal.bind(shell)
  shell.openExternal = async (authorizeUrl: string): Promise<void> => {
    const loc = (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location')
    if (loc) await fetch(loc)
  }

  const run = async (): Promise<void> => {
    try {
      fixture = await startFixture(state)
      const mk = (id: string, path: string, authKinds: McpPreset['authKinds']): McpPreset => ({
        id,
        label: id,
        transport: 'http',
        urlOrCommand: `${origin}${path}`,
        authKinds,
        envRefSlots: [],
        cliQuirks: {},
        grantCopy: 'Fixture connection for the TOOLWHO gate.',
        verifiedAt: '2026-07-24'
      })
      ;(MCP_PRESETS as McpPreset[]).push(
        mk('who-oidc', '/oidc-mcp', ['oauth']),
        mk('who-rest', '/rest-mcp', ['token']),
        mk('who-tool', '/tool-mcp', ['token']),
        mk('who-none', '/none-mcp', ['token'])
      )
      // The catalog row that DRIVES (b): rest profile with paths a generic walk
      // could never guess (`contact` is not an email-shaped key name).
      injectProviderEntryForSmoke({
        id: 'who-rest',
        label: 'who-rest',
        source: 'fixture://toolwho',
        mcp: { transport: 'http', url: `${origin}/rest-mcp` },
        methods: [{ key: 'apiKey', kind: 'apiKey', name: 'API key', rank: 1 }],
        profile: {
          via: 'rest',
          url: `${origin}/rest-user`,
          paths: { id: 'uid', email: 'contact||email', name: 'profile.name' },
          source: 'fixture://toolwho'
        }
      } as ProviderEntry)

      // ── Connect the four ─────────────────────────────────────────────────────
      const c1 = await connect('who-oidc')
      if (!c1.ok) throw new Error(`connect who-oidc refused: ${c1.reason}`)
      await sleep(800) // let the landed-grant enrichment settle
      for (const [id, key] of [['who-rest', 'key-rest'], ['who-tool', 'key-tool'], ['who-none', 'key-none']] as const) {
        const r = await submitKey(id, key)
        if (!r.ok) throw new Error(`submitKey ${id} refused: ${r.reason}`)
      }

      // ── (a) oidc: claims in hand land as the profile, sourced honestly ───────
      await verifyConnection('who-oidc', 'manual')
      const oidc = stateOf('who-oidc')
      const oidcOk = oidc?.accountProfile?.email === 'who@fixture.test' && oidc?.accountSource === 'oidc' && oidc?.state === 'connected'

      // ── (b) rest: the exact catalog endpoint, the exact catalog paths ────────
      const restHitsBefore = state.restUserHits
      await verifyConnection('who-rest', 'manual')
      const rest = stateOf('who-rest')
      const restOk =
        state.restUserHits === restHitsBefore + 1 &&
        state.restUserPaths.every((x) => x === '/rest-user') &&
        rest?.accountProfile?.email === 'rest@fixture.test' && // reachable ONLY via the `contact` path
        rest?.accountProfile?.name === 'Rest Person' && // nested `profile.name` path applied
        rest?.accountProfile?.id === '7' &&
        rest?.accountSource === 'rest'

      // ── (c) tool: one whoami call where allowed, ZERO where not ─────────────
      const toolCallsBefore = calls('tool-mcp')
      await verifyConnection('who-tool', 'manual')
      const tool = stateOf('who-tool')
      const toolOk =
        calls('tool-mcp') === toolCallsBefore + 1 &&
        (state.toolCalls.get('tool-mcp')?.names ?? []).every((n) => n === 'get_me') &&
        tool?.accountProfile?.email === 'tool@fixture.test' &&
        tool?.accountSource === 'tool'
      const noneCallsBefore = calls('none-mcp')
      await verifyConnection('who-none', 'manual')
      const none = stateOf('who-none')
      const noneZeroOk = calls('none-mcp') === noneCallsBefore && !none?.accountProfile && none?.state === 'connected'

      // ── (e) stability: identity once probed is never re-asked ───────────────
      const restHits2 = state.restUserHits
      const toolCalls2 = calls('tool-mcp')
      await verifyConnection('who-rest', 'heartbeat')
      await verifyConnection('who-tool', 'heartbeat')
      const stabilityOk = state.restUserHits === restHits2 && calls('tool-mcp') === toolCalls2

      // ── (d) fallback + the note, on the REAL page ────────────────────────────
      await ES(`(document.querySelector('.titlebar-right .icon-btn[aria-label="Settings"]')?.click(), 1)`)
      await sleep(500)
      await ES(`(document.querySelector('.settings-nav-item[data-target="integrations"]')?.click(), 1)`)
      await sleep(1500)
      const fallbackOk = await ES<boolean>(`(() => {
        const row = document.querySelector('.conn-card[data-connection="who-none"] .conn-identity')
        if (!row) return false
        const text = row.querySelector('.conn-identity-text')?.textContent ?? ''
        const btn = row.querySelector('.conn-note-edit')?.textContent ?? ''
        return row.classList.contains('is-none') && /doesn’t share an account name/.test(text) && /Add a note/.test(btn)
      })()`)
      // The note goes in over the REAL channel; the push repaints the grid.
      await ES(`window.bridge.invoke('connections:setNote', { serviceId: 'who-none', note: '  ops team account  ' })`)
      await ES(`window.bridge.invoke('connections:setNote', { serviceId: 'who-rest', note: 'a different person' })`)
      await sleep(800)
      const notedOk = await ES<boolean>(`(() => {
        const row = document.querySelector('.conn-card[data-connection="who-none"] .conn-identity')
        const text = row?.querySelector('.conn-identity-text')?.textContent ?? ''
        return !!row && row.classList.contains('is-noted') && text === 'ops team account · noted by you'
      })()`)
      // Probed beats noted: the provider's answer owns the row; the note rides secondary.
      const probedWinsOk = await ES<boolean>(`(() => {
        const row = document.querySelector('.conn-card[data-connection="who-rest"] .conn-identity')
        if (!row || !row.classList.contains('is-probed')) return false
        const text = row.querySelector('.conn-identity-text')?.textContent ?? ''
        const secondary = row.querySelector('.conn-note-secondary')?.textContent ?? ''
        return text === 'rest@fixture.test' && secondary === 'a different person · noted by you'
      })()`)
      // Survives disconnect + reconnect — only the user deletes a note.
      disconnect('who-none')
      const noteAfterDisconnect = stateOf('who-none')?.accountNote === 'ops team account'
      const rc = await submitKey('who-none', 'key-none')
      const noteAfterReconnect = rc.ok && stateOf('who-none')?.accountNote === 'ops team account'

      // ── MUTATION-RED 1: a broken allowlist match must make (c) red ───────────
      const noneCallsBeforeMutation = calls('none-mcp')
      process.env.MOGGING_WHO_BREAK_ALLOWLIST = '1'
      await verifyConnection('who-none', 'manual')
      delete process.env.MOGGING_WHO_BREAK_ALLOWLIST
      const mutationAllowlistRed = calls('none-mcp') > noneCallsBeforeMutation

      // ── MUTATION-RED 2: inverted precedence must make (d)'s assert red ───────
      const probedCard = stateOf('who-rest')
      const normalRow = probedCard ? connectionIdentityRow(probedCard) : null
      const mutatedRow = probedCard ? connectionIdentityRow(probedCard, { _testNotedBeatsProbed: true }) : null
      const mutationPrecedenceRed = normalRow?.kind === 'probed' && mutatedRow?.kind === 'noted'

      result = {
        pass:
          oidcOk &&
          restOk &&
          toolOk &&
          noneZeroOk &&
          stabilityOk &&
          fallbackOk &&
          notedOk &&
          probedWinsOk &&
          noteAfterDisconnect &&
          noteAfterReconnect &&
          mutationAllowlistRed &&
          mutationPrecedenceRed,
        oidcOk,
        restOk,
        toolOk,
        noneZeroOk,
        stabilityOk,
        fallbackOk,
        notedOk,
        probedWinsOk,
        noteAfterDisconnect,
        noteAfterReconnect,
        mutationAllowlistRed,
        mutationPrecedenceRed,
        observed: {
          oidc: { email: oidc?.accountProfile?.email ?? null, source: oidc?.accountSource ?? null },
          rest: { profile: rest?.accountProfile ?? null, source: rest?.accountSource ?? null, hits: state.restUserHits },
          tool: { profile: tool?.accountProfile ?? null, source: tool?.accountSource ?? null, calls: state.toolCalls.get('tool-mcp') ?? null },
          none: { calls: calls('none-mcp'), note: stateOf('who-none')?.accountNote ?? null }
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
      writeFileSync(join(process.cwd(), 'out', 'toolwho-result.json'), JSON.stringify(result, null, 2))
    } catch {
      /* best effort */
    }
    clearTimeout(safety)
    app.exit(result.pass ? 0 : 1)
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(() => void run(), 3000))
  else setTimeout(() => void run(), 3000)
}
