// The pre-registered OAuth client regression suite — pure, hermetic, no Electron.
//
//   npm run smoke:preregistered-client-pure        (qa-smokes gate: PREREGCLIENT)
//
// A local FIXTURE with THREE authorization servers — one with no dynamic client
// registration (accounts.google.com's shape), one with working DCR, one whose
// registration endpoint refuses — drives the REAL client code
// (src/backend/features/integrations/oauth.ts + client-registry.ts). Nothing here
// touches the network beyond 127.0.0.1, so CI runs it on every push — and every
// assertion is regression-shaped: each encodes a rule that failed silently when
// broken, or would have.
//
//   · a no-DCR provider must fail ACTIONABLY: `needsClientId` set, so the card
//     renders a paste form instead of a Reconnect that can only fail again;
//   · a refusing-but-EXISTING registration endpoint must NOT set `needsClientId`
//     (pasting a client id would not fix a 500);
//   · a pasted client drives the full PKCE flow: its id rides authorize, its
//     SECRET rides the token exchange (Google refuses the exchange without it),
//     and refresh + rotation work unchanged;
//   · client records are keyed per ISSUER: the client pasted on the Drive card
//     is found again from the Gmail card — one client, all of Google Workspace;
//   · a `user` record survives a redirect-uri mismatch (we cannot re-register to
//     replace it) while a `dcr` record stays purgeable, and the advice matches
//     what "try again" will actually do;
//   · paste hygiene: trims, refuses multi-token ids and pasted paragraphs, and
//     an empty secret is NO secret — `""` never reaches a token request.
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  buildAuthorizeUrl,
  canRepairClientByReRegistering,
  createPkce,
  createState,
  discoverAuthServer,
  exchangeCode,
  redirectDriftAdvice,
  refreshTokens,
  mergeRefreshedTokens,
  resolveClient,
  sanitizeUserClient,
  userClientRecord,
  type ClientStore
} from '@backend/features/integrations'
import type { OAuthClientRecord } from '@contracts'

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
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: suite exceeded 60s — failing hard')
  process.exit(1)
}, 60_000)

const b64url = (s: Buffer | string): string =>
  (typeof s === 'string' ? Buffer.from(s) : s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256b64url = (s: string): string => b64url(createHash('sha256').update(s).digest())

/** An in-memory ClientStore that RECORDS its traffic, so a test can assert not
 *  just outcomes but that e.g. no registration was attempted over a seeded record. */
function memStore(): ClientStore & { saved: OAuthClientRecord[]; loads: string[] } {
  const map = new Map<string, OAuthClientRecord>()
  const saved: OAuthClientRecord[] = []
  const loads: string[] = []
  return {
    saved,
    loads,
    load: (issuer) => {
      loads.push(issuer)
      return map.get(issuer) ?? null
    },
    save: (issuer, record) => {
      saved.push(record)
      map.set(issuer, record)
      return true
    },
    clear: (issuer) => void map.delete(issuer)
  }
}

// ── The fixture: three AS shapes, two resources behind the no-DCR one ────────
const USER_CLIENT_ID = 'user-client-42.apps.example'
const USER_CLIENT_SECRET = 'shh-user-secret'

interface FixtureState {
  authorizeClientIds: string[]
  tokenForms: URLSearchParams[]
  challenge: string | null
  codes: Map<string, string> // code -> resource it was minted for
  refreshValid: Set<string>
  registerCalls: number
}
const S: FixtureState = {
  authorizeClientIds: [],
  tokenForms: [],
  challenge: null,
  codes: new Map(),
  refreshValid: new Set(),
  registerCalls: 0
}

let origin = ''
const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => resolve(s))
  })
}

/** RFC 8414 metadata for an AS at `${origin}/${slug}` — DCR only where told. */
const asMetadata = (slug: string, dcr: 'none' | 'works' | 'refuses'): Record<string, unknown> => ({
  issuer: `${origin}/${slug}`,
  authorization_endpoint: `${origin}/${slug}/authorize`,
  token_endpoint: `${origin}/${slug}/token`,
  ...(dcr === 'none' ? {} : { registration_endpoint: `${origin}/${slug}/register` }),
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp:use', 'openid', 'email']
})

function startFixture(): Promise<{ close: () => void }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = req.method === 'POST' ? await readBody(req) : ''
        const p = url.pathname

        // ── Two MCP resources behind ONE no-DCR AS (the Google Workspace shape) ──
        if (p === '/drive-mcp' || p === '/gmail-mcp') {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm${p}"` }).end()
          return
        }
        if (p === '/prm/drive-mcp' || p === '/prm/gmail-mcp') {
          const resource = p.replace('/prm', '')
          return sendJson(res, 200, { resource: `${origin}${resource}`, authorization_servers: [`${origin}/nodcr-as`], scopes_supported: ['mcp:use'] })
        }
        // One resource behind the DCR AS, one behind the refusing-DCR AS.
        if (p === '/dcr-mcp' || p === '/dcr500-mcp') {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/prm${p}"` }).end()
          return
        }
        if (p === '/prm/dcr-mcp') {
          return sendJson(res, 200, { resource: `${origin}/dcr-mcp`, authorization_servers: [`${origin}/dcr-as`], scopes_supported: ['mcp:use'] })
        }
        if (p === '/prm/dcr500-mcp') {
          return sendJson(res, 200, { resource: `${origin}/dcr500-mcp`, authorization_servers: [`${origin}/dcr500-as`], scopes_supported: ['mcp:use'] })
        }

        // ── RFC 8414, path-inserted ──
        if (p === '/.well-known/oauth-authorization-server/nodcr-as') return sendJson(res, 200, asMetadata('nodcr-as', 'none'))
        if (p === '/.well-known/oauth-authorization-server/dcr-as') return sendJson(res, 200, asMetadata('dcr-as', 'works'))
        if (p === '/.well-known/oauth-authorization-server/dcr500-as') return sendJson(res, 200, asMetadata('dcr500-as', 'refuses'))

        // ── DCR endpoints ──
        if (p === '/dcr-as/register' && req.method === 'POST') {
          S.registerCalls++
          return sendJson(res, 201, { client_id: 'dcr-client-77' })
        }
        if (p === '/dcr500-as/register' && req.method === 'POST') {
          S.registerCalls++
          return sendJson(res, 500, { error: 'server_error' })
        }

        // ── The no-DCR AS: authorize + token REQUIRE the user's pasted client ──
        if (p === '/nodcr-as/authorize') {
          const q = url.searchParams
          S.authorizeClientIds.push(q.get('client_id') ?? '')
          if (q.get('client_id') !== USER_CLIENT_ID) return sendJson(res, 400, { error: 'invalid_client' })
          if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('resource') || !q.get('state')) {
            return sendJson(res, 400, { error: 'invalid_request' })
          }
          S.challenge = q.get('code_challenge')
          const code = `code-${randomBytes(6).toString('hex')}`
          S.codes.set(code, q.get('resource') ?? '')
          res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` }).end()
          return
        }
        if (p === '/nodcr-as/token' && req.method === 'POST') {
          const form = new URLSearchParams(body)
          S.tokenForms.push(form)
          if (form.get('client_id') !== USER_CLIENT_ID) return sendJson(res, 400, { error: 'invalid_client' })
          // Google's shape: the token exchange REQUIRES the client secret even for
          // installed-app clients. A client that drops it fails right here.
          if (form.get('client_secret') !== USER_CLIENT_SECRET) {
            return sendJson(res, 401, { error: 'invalid_client', error_description: 'client secret required' })
          }
          if (form.get('grant_type') === 'authorization_code') {
            const code = form.get('code') ?? ''
            const mintedFor = S.codes.get(code)
            if (mintedFor === undefined) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code already used or unknown' })
            S.codes.delete(code)
            if (sha256b64url(form.get('code_verifier') ?? '') !== S.challenge) {
              return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
            }
            if (form.get('resource') !== mintedFor) {
              return sendJson(res, 400, { error: 'invalid_target', error_description: 'resource mismatch' })
            }
            S.refreshValid.add('rt-u1')
            return sendJson(res, 200, { access_token: 'at-u1', refresh_token: 'rt-u1', expires_in: 3600, scope: 'mcp:use' })
          }
          if (form.get('grant_type') === 'refresh_token') {
            const rt = form.get('refresh_token') ?? ''
            if (!S.refreshValid.delete(rt)) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token is not valid' })
            if (rt === 'rt-u1') {
              S.refreshValid.add('rt-u2')
              return sendJson(res, 200, { access_token: 'at-u2', refresh_token: 'rt-u2', expires_in: 3600 })
            }
            S.refreshValid.add('rt-u2')
            return sendJson(res, 200, { access_token: 'at-u3', expires_in: 3600 })
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

// ── The suite ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const fixture = await startFixture()
  const redirectUri = 'http://127.0.0.1:39999/callback'

  // P1 — paste hygiene: what a user actually pastes, held to honest rules
  const p1 = sanitizeUserClient(`  ${USER_CLIENT_ID}\n`, `  ${USER_CLIENT_SECRET} `)
  check(p1.ok && p1.clientId === USER_CLIENT_ID && p1.clientSecret === USER_CLIENT_SECRET, 'P1 id and secret are trimmed')
  const p1empty = sanitizeUserClient('   ')
  check(!p1empty.ok && /Paste the client ID first/.test(p1empty.reason), 'P1 an empty/whitespace id is refused with the actionable sentence')
  check(!sanitizeUserClient('two tokens').ok, 'P1 an id with internal whitespace is refused (a sentence is not a client id)')
  check(!sanitizeUserClient('a'.repeat(257)).ok, 'P1 a pasted paragraph is refused by length')
  const p1nosecret = sanitizeUserClient(USER_CLIENT_ID)
  check(p1nosecret.ok && p1nosecret.clientSecret === undefined, 'P1 the secret is optional (public clients exist)')
  const p1blanksecret = sanitizeUserClient(USER_CLIENT_ID, '   ')
  check(p1blanksecret.ok && p1blanksecret.clientSecret === undefined, 'P1 a whitespace-only secret is NO secret, never a literal ""')
  check(!sanitizeUserClient(USER_CLIENT_ID, 's'.repeat(513)).ok, 'P1 an over-long secret is refused')

  // P2 — the record a pasted client becomes
  const rec = userClientRecord(`${origin}/nodcr-as`, USER_CLIENT_ID, USER_CLIENT_SECRET)
  check(rec.source === 'user' && rec.clientId === USER_CLIENT_ID && typeof rec.registeredAt === 'number', 'P2 user record carries source:user')
  check(!('clientSecret' in userClientRecord('i', 'c')), 'P2 a secret-less record has NO clientSecret key (never undefined-as-a-key)')

  // P3 — discovery on the Google-shaped resource, then the ACTIONABLE no-DCR refusal
  const drive = await discoverAuthServer(`${origin}/drive-mcp`, { requireAuth: true })
  check(drive.ok && drive.metadata.issuer === `${origin}/nodcr-as`, 'P3 discovery finds the no-DCR AS')
  if (!drive.ok) throw new Error('cannot continue without discovery')
  check(drive.metadata.registration_endpoint === undefined, 'P3 fixture sanity: the AS really offers no DCR')
  const empty = memStore()
  const refusal = await resolveClient(drive.metadata, redirectUri, empty)
  check(!refusal.ok && refusal.needsClientId === true, 'P3 no DCR + no record → needsClientId (the card renders a form, not a dead Reconnect)')
  check(!refusal.ok && /pre-registered client id/.test(refusal.reason), 'P3 the refusal names what is needed, in words')
  check(empty.saved.length === 0, 'P3 nothing was saved on the refusal path')

  // P4 — a refusing-but-EXISTING registration endpoint must NOT ask for a client id
  const dcr500 = await discoverAuthServer(`${origin}/dcr500-mcp`, { requireAuth: true })
  check(dcr500.ok, 'P4 discovery finds the refusing-DCR AS')
  if (dcr500.ok) {
    const refused = await resolveClient(dcr500.metadata, redirectUri, memStore())
    check(!refused.ok && refused.needsClientId === undefined, 'P4 a 500 from a live registration endpoint does NOT set needsClientId')
    check(!refused.ok && /refused the registration/.test(refused.reason), 'P4 the 500 is reported as the provider refusing')
  }

  // P5 — a seeded user record resolves with no registration attempt
  const seeded = memStore()
  seeded.save(drive.metadata.issuer, rec)
  const registerCallsBefore = S.registerCalls
  const resolved = await resolveClient(drive.metadata, redirectUri, seeded)
  check(resolved.ok && resolved.client.clientId === USER_CLIENT_ID && resolved.client.source === 'user', 'P5 a stored user client is used as-is')
  check(S.registerCalls === registerCallsBefore, 'P5 no registration was attempted over a stored record')

  // P6 — the pasted client drives the FULL flow: authorize, secret-proven exchange
  const pkce = createPkce()
  const state = createState()
  const authRes = await fetch(
    buildAuthorizeUrl({ metadata: drive.metadata, clientId: rec.clientId, redirectUri, resource: drive.resource, challenge: pkce.challenge, state, scopes: ['mcp:use'] }),
    { redirect: 'manual' }
  )
  const code = new URL(authRes.headers.get('location') ?? 'http://x/?').searchParams.get('code') ?? ''
  check(authRes.status === 302 && !!code, 'P6 authorize accepts the pasted client id and issues a code')
  check(S.authorizeClientIds.at(-1) === USER_CLIENT_ID, 'P6 the pasted id — not a registered one — rode the authorize request')
  const secretless: OAuthClientRecord = { authServer: rec.authServer, clientId: rec.clientId, registeredAt: rec.registeredAt, source: 'user' }
  const noSecret = await exchangeCode(drive.metadata, secretless, { code, verifier: pkce.verifier, redirectUri, resource: drive.resource })
  check(!noSecret.ok && /client secret required/.test(noSecret.reason), 'P6 fixture sanity: this AS refuses an exchange without the secret (the Google shape)')
  const authRes2 = await fetch(
    buildAuthorizeUrl({ metadata: drive.metadata, clientId: rec.clientId, redirectUri, resource: drive.resource, challenge: pkce.challenge, state, scopes: ['mcp:use'] }),
    { redirect: 'manual' }
  )
  const code2 = new URL(authRes2.headers.get('location') ?? 'http://x/?').searchParams.get('code') ?? ''
  const exchanged = await exchangeCode(drive.metadata, rec, { code: code2, verifier: pkce.verifier, redirectUri, resource: drive.resource })
  check(exchanged.ok && exchanged.tokens.accessToken === 'at-u1', 'P6 the exchange lands tokens with the pasted client')
  const lastForm = S.tokenForms.at(-1)
  check(lastForm?.get('client_secret') === USER_CLIENT_SECRET, 'P6 the pasted SECRET rode the token exchange')
  check(lastForm?.get('code_verifier') !== undefined && lastForm?.get('resource') === drive.resource, 'P6 PKCE and resource-binding are unchanged by a pasted client')

  // P7 — one issuer, one record: the client pasted on Drive serves Gmail too
  const gmail = await discoverAuthServer(`${origin}/gmail-mcp`, { requireAuth: true })
  check(gmail.ok && gmail.metadata.issuer === drive.metadata.issuer, 'P7 both Workspace resources sign in at the SAME issuer')
  if (gmail.ok) {
    const again = await resolveClient(gmail.metadata, redirectUri, seeded)
    check(again.ok && again.client.clientId === USER_CLIENT_ID, 'P7 the Drive-pasted client is found from the Gmail card (keyed per issuer)')
    const gAuth = await fetch(
      buildAuthorizeUrl({ metadata: gmail.metadata, clientId: USER_CLIENT_ID, redirectUri, resource: gmail.resource, challenge: pkce.challenge, state, scopes: ['mcp:use'] }),
      { redirect: 'manual' }
    )
    const gCode = new URL(gAuth.headers.get('location') ?? 'http://x/?').searchParams.get('code') ?? ''
    const gExchanged = await exchangeCode(gmail.metadata, rec, { code: gCode, verifier: pkce.verifier, redirectUri, resource: gmail.resource })
    check(gExchanged.ok, 'P7 the same client completes a second service’s exchange (its own resource binding)')
  }

  // P8 — refresh + rotation with a pasted client, unchanged
  const r1 = await refreshTokens(drive.metadata, rec, { refreshToken: 'rt-u1', resource: drive.resource })
  check(r1.ok && r1.tokens.refreshToken === 'rt-u2', 'P8 refresh rotates under a pasted client')
  const r2 = await refreshTokens(drive.metadata, rec, { refreshToken: 'rt-u2', resource: drive.resource })
  check(r2.ok && r2.tokens.refreshToken === undefined, 'P8 second refresh omits the refresh token')
  if (r1.ok && r2.ok) {
    check(mergeRefreshedTokens(r1.tokens, r2.tokens).refreshToken === 'rt-u2', 'P8 the merge rule holds regardless of who registered the client')
  }

  // P9 — the DCR path is UNCHANGED, and its records stay purgeable
  const dcr = await discoverAuthServer(`${origin}/dcr-mcp`, { requireAuth: true })
  check(dcr.ok, 'P9 discovery finds the DCR AS')
  if (dcr.ok) {
    const store = memStore()
    const viaDcr = await resolveClient(dcr.metadata, redirectUri, store)
    check(viaDcr.ok && viaDcr.client.clientId === 'dcr-client-77', 'P9 DCR still registers where offered')
    check(store.saved.at(-1)?.source === 'dcr', 'P9 a DCR record is tagged as such when saved')
    const cached = await resolveClient(dcr.metadata, redirectUri, store)
    check(cached.ok && cached.client.clientId === 'dcr-client-77', 'P9 the saved DCR record is reused')
  }

  // P10 — what a redirect-uri mismatch may destroy, and what it must say
  check(canRepairClientByReRegistering({ authServer: 'a', clientId: 'c', registeredAt: 0, source: 'dcr' }), 'P10 a dcr record is purgeable (we can re-register)')
  check(canRepairClientByReRegistering({ authServer: 'a', clientId: 'c', registeredAt: 0 }), 'P10 a legacy record (no source) is purgeable')
  check(!canRepairClientByReRegistering(rec), 'P10 a user record is NEVER purgeable (we cannot restore it)')
  const dcrAdvice = redirectDriftAdvice({ authServer: 'a', clientId: 'c', registeredAt: 0 }, 'redirect_uri mismatch')
  check(/re-register/.test(dcrAdvice), 'P10 dcr advice promises the re-register that will actually happen')
  const userAdvice = redirectDriftAdvice(rec, 'redirect_uri mismatch')
  check(/127\.0\.0\.1/.test(userAdvice) && /Desktop app/.test(userAdvice), 'P10 user advice names the real fix (loopback redirects / Desktop app)')
  check(!/re-register/.test(userAdvice), 'P10 user advice never promises a re-register we cannot perform')
  check(/per-CLI/.test(userAdvice), 'P10 user advice names the way out when the vendor cannot allow loopback at all (Slack)')

  // P11 — a store that refuses (no keychain) is a hard stop with the honest sentence
  if (dcr.ok) {
    const refusing: ClientStore = { load: () => null, save: () => false, clear: () => undefined }
    const stopped = await resolveClient(dcr.metadata, redirectUri, refusing)
    check(!stopped.ok && /keychain/.test(stopped.reason), 'P11 a refusing store stops the flow naming the keychain')
  }

  fixture.close()
  clearTimeout(watchdog)
  console.log(`\npreregistered-client-pure: ${passes} passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('FAILED:\n' + failures.map((f) => `  · ${f}`).join('\n'))
    process.exit(1)
  }
}

void main().catch((e) => {
  console.error('SUITE ERROR:', e)
  process.exit(1)
})
