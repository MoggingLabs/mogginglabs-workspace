import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey as CryptoJwk,
  type KeyObject
} from 'node:crypto'
import type { AuthServerMetadata } from '../integrations/oauth'

// A deterministic, in-process authorization server for the account flow — the ONLY
// IdP the smoke and the gallery ever touch (zero external network, by construction).
// The real MoggingLabs IdP is the operator's later wiring; account.ts talks to
// whichever config it is handed, and the smoke hands it this.
//
// It is a REAL HTTP server for the parts account.ts exercises for real — the token
// endpoint (POST /token) and the metadata/JWKS documents — so the production code path
// (PKCE exchange, DPoP header, nonce dance, rotation) runs unmodified against it. The
// "browser" half (GET /authorize consent) has no real browser under a gate, so the
// smoke drives it through `consent()`, which performs the redirect the browser would.
//
// It enforces the two things that make the account tamper-resistant, so the smoke can
// PROVE them: PKCE(S256) on the code exchange, and DPoP sender-constraint — a refresh
// whose proof thumbprint (`jkt`) does not match the one bound at login is rejected
// (RFC 9449). It also runs the RFC 9449 §8 nonce dance (400 `use_dpop_nonce` + a
// `DPoP-Nonce` header on the first token request), so account.ts's retry path is live
// every run rather than dead code.

export type FakeIdpScenario = 'success' | 'cancel' | 'expired-code'

export interface FakeIdpOptions {
  email?: string
  plan?: string
  /** Access-token lifetime in seconds (the smoke forces expiry to test refresh). */
  accessTtlSec?: number
}

interface CodeRecord {
  challenge: string
  redirectUri: string
  resource: string
  used: boolean
  expired: boolean
}

interface GrantRecord {
  jkt: string
  email: string
  plan: string
  resource: string
  revoked: boolean
}

const b64url = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const b64urlJson = (o: unknown): string => b64url(JSON.stringify(o))

const b64urlDecode = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/** RFC 7638 EC thumbprint — the same computation the client's DpopKey.jkt runs, so a
 *  match here proves the SAME key signed the proof. */
function jwkThumbprint(jwk: { kty?: string; crv?: string; x?: string; y?: string }): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  return b64url(createHash('sha256').update(canonical).digest())
}

export class FakeIdp {
  private server: Server | null = null
  private port = 0
  private readonly signingKey: KeyObject
  private readonly signingPubJwk: Record<string, unknown>
  private readonly email: string
  private readonly plan: string
  private readonly accessTtlSec: number
  private readonly nonce = b64url(randomBytes(16))

  private scenario: FakeIdpScenario = 'success'
  private readonly codes = new Map<string, CodeRecord>()
  private readonly grants = new Map<string, GrantRecord>() // refreshToken -> grant
  readonly clientId = 'mogging-desktop'

  // Introspection — for the smoke only, never touched by production.
  tokenRequests = 0
  nonceChallenges = 0
  proofsVerified = 0
  lastBoundJkt: string | null = null
  readonly issuedRefresh: string[] = []

  constructor(opts: FakeIdpOptions = {}) {
    this.email = opts.email ?? 'founder@mogginglabs.example'
    this.plan = opts.plan ?? 'pro'
    this.accessTtlSec = opts.accessTtlSec ?? 300
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.signingKey = privateKey
    this.signingPubJwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), use: 'sig', alg: 'ES256', kid: 'fake-idp-1' }
  }

  setScenario(s: FakeIdpScenario): void {
    this.scenario = s
  }

  /** Server-side revocation of every outstanding grant (the "revoked-refresh" case:
   *  the next refresh drops the client cleanly to anon). */
  revokeAll(): void {
    for (const g of this.grants.values()) g.revoked = true
  }

  get metadata(): AuthServerMetadata {
    const base = `http://127.0.0.1:${this.port}`
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      scopes_supported: ['openid', 'email', 'entitlements'],
      userinfo_endpoint: `${base}/userinfo`
    }
  }

  get tokenEndpoint(): string {
    return `http://127.0.0.1:${this.port}/token`
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => void this.route(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as AddressInfo).port
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  /** The browser half, simulated: fetch the authorize endpoint (which 302s to the
   *  loopback with a code or an error) and return that redirect for the caller to
   *  deliver to account.ts's loopback server. */
  async consent(authorizeUrl: string): Promise<{ redirectTo: string }> {
    const res = await fetch(authorizeUrl, { redirect: 'manual' })
    const loc = res.headers.get('location')
    if (!loc) throw new Error(`fake-idp /authorize did not redirect (status ${res.status})`)
    return { redirectTo: loc }
  }

  /** Craft a valid-signature DPoP proof with a FOREIGN key over a real refresh token
   *  and present it — the AS must reject it (sender-constraint). Proves a lifted
   *  refresh token is inert without the bound key, without leaving this process. */
  async probeForeignKeyRefresh(): Promise<{ rejected: boolean; status: number }> {
    const rt = this.issuedRefresh.filter((t) => !this.grants.get(t)?.revoked).slice(-1)[0]
    if (!rt) return { rejected: false, status: 0 }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk }
    const payload = { jti: b64url(randomBytes(12)), htm: 'POST', htu: this.tokenEndpoint, iat: Math.floor(Date.now() / 1000), nonce: this.nonce }
    const input = `${b64urlJson(header)}.${b64urlJson(payload)}`
    const proof = `${input}.${b64url(sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`
    const r = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', DPoP: proof },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: this.clientId })
    })
    return { rejected: r.status >= 400, status: r.status }
  }

  // ── HTTP routing ─────────────────────────────────────────────────────────────
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (req.method === 'GET' && url.pathname === '/authorize') return this.authorize(url, res)
    if (req.method === 'POST' && url.pathname === '/token') return this.token(req, res)
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      return this.json(res, 200, { keys: [this.signingPubJwk] })
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return this.json(res, 200, this.metadata as unknown as Record<string, unknown>)
    }
    res.writeHead(404).end()
  }

  private authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams
    const redirectUri = q.get('redirect_uri') ?? ''
    const state = q.get('state') ?? ''
    // A loopback redirect_uri is the only shape we ever issue to (RFC 8252).
    if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) {
      return this.json(res, 400, { error: 'invalid_request', error_description: 'bad redirect_uri' })
    }
    if (this.scenario === 'cancel') {
      res.writeHead(302, { location: `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}` }).end()
      return
    }
    const challenge = q.get('code_challenge') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || !challenge) {
      return this.json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' })
    }
    const code = b64url(randomBytes(24))
    this.codes.set(code, {
      challenge,
      redirectUri,
      resource: q.get('resource') ?? '',
      used: false,
      expired: this.scenario === 'expired-code'
    })
    res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` }).end()
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.tokenRequests += 1
    const body = await readBody(req)
    const form = new URLSearchParams(body)

    // DPoP is mandatory on every token request. Run the RFC 9449 §8 nonce dance: the
    // first proof carries no nonce, so we 400 with one and the client retries.
    const proof = String(req.headers['dpop'] ?? '')
    const v = this.verifyDpop(proof)
    if (!v.ok && v.needNonce) {
      this.nonceChallenges += 1
      res.writeHead(400, { 'content-type': 'application/json', 'DPoP-Nonce': this.nonce })
      res.end(JSON.stringify({ error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' }))
      return
    }
    if (!v.ok) return this.json(res, 400, { error: 'invalid_dpop_proof', error_description: v.error })
    this.proofsVerified += 1
    // A fresh nonce header rides every success too (client caches it, RFC 9449 §8).
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') return this.exchange(form, v.jkt, res)
    if (grantType === 'refresh_token') return this.refresh(form, v.jkt, res)
    return this.json(res, 400, { error: 'unsupported_grant_type' })
  }

  private exchange(form: URLSearchParams, jkt: string, res: ServerResponse): void {
    const code = form.get('code') ?? ''
    const rec = this.codes.get(code)
    if (!rec || rec.used) return this.json(res, 400, { error: 'invalid_grant', error_description: 'unknown or used code' })
    rec.used = true
    if (rec.expired) return this.json(res, 400, { error: 'invalid_grant', error_description: 'authorization code expired' })
    if (form.get('redirect_uri') !== rec.redirectUri) return this.json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
    // PKCE(S256): the verifier must hash to the challenge we stored at /authorize.
    const verifier = form.get('code_verifier') ?? ''
    const computed = b64url(createHash('sha256').update(verifier).digest())
    if (!verifier || computed !== rec.challenge) return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verify failed' })
    this.lastBoundJkt = jkt
    this.issueTokens(jkt, rec.resource, res)
  }

  private refresh(form: URLSearchParams, jkt: string, res: ServerResponse): void {
    const rt = form.get('refresh_token') ?? ''
    const grant = this.grants.get(rt)
    if (!grant || grant.revoked) return this.json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked or unknown' })
    // Sender-constraint: the proof key MUST be the one bound at login. A refresh token
    // lifted from the vault, presented with any other key, dies right here.
    if (jkt !== grant.jkt) return this.json(res, 400, { error: 'invalid_dpop_proof', error_description: 'DPoP key does not match the bound key' })
    // ROTATION: invalidate the presented refresh token, issue a fresh one.
    grant.revoked = true
    this.issueTokens(jkt, grant.resource, res, grant)
  }

  private issueTokens(jkt: string, resource: string, res: ServerResponse, prev?: GrantRecord): void {
    const email = prev?.email ?? this.email
    const plan = prev?.plan ?? this.plan
    const refreshToken = b64url(randomBytes(32))
    this.grants.set(refreshToken, { jkt, email, plan, resource, revoked: false })
    this.issuedRefresh.push(refreshToken)
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: this.metadata.issuer, sub: 'user-1', aud: this.clientId, email, plan, cnf: { jkt }, iat: now, exp: now + this.accessTtlSec }
    const accessToken = this.signJwt({ alg: 'ES256', typ: 'at+jwt', kid: 'fake-idp-1' }, { ...claims, scope: 'openid email entitlements' })
    const idToken = this.signJwt({ alg: 'ES256', typ: 'JWT', kid: 'fake-idp-1' }, claims)
    res.writeHead(200, { 'content-type': 'application/json', 'DPoP-Nonce': this.nonce })
    res.end(
      JSON.stringify({
        token_type: 'DPoP',
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        expires_in: this.accessTtlSec,
        scope: 'openid email entitlements'
      })
    )
  }

  private verifyDpop(proof: string): { ok: true; jkt: string } | { ok: false; error: string; needNonce?: boolean } {
    if (!proof) return { ok: false, error: 'missing DPoP proof', needNonce: true }
    const parts = proof.split('.')
    if (parts.length !== 3) return { ok: false, error: 'malformed proof' }
    let header: { typ?: string; alg?: string; jwk?: { kty?: string; crv?: string; x?: string; y?: string } }
    let payload: { htm?: string; htu?: string; nonce?: string; jti?: string }
    try {
      header = JSON.parse(b64urlDecode(parts[0]))
      payload = JSON.parse(b64urlDecode(parts[1]))
    } catch {
      return { ok: false, error: 'unparseable proof' }
    }
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) return { ok: false, error: 'bad proof header' }
    if (payload.htm !== 'POST' || payload.htu !== this.tokenEndpoint) return { ok: false, error: 'htm/htu mismatch' }
    let pub: KeyObject
    try {
      pub = createPublicKey({ key: header.jwk as unknown as CryptoJwk, format: 'jwk' })
    } catch {
      return { ok: false, error: 'bad jwk' }
    }
    const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(parts[2]))
    if (!ok) return { ok: false, error: 'bad proof signature' }
    // Nonce required (RFC 9449 §8) — absent/stale nonce triggers the 400 dance.
    if (payload.nonce !== this.nonce) return { ok: false, error: 'nonce required', needNonce: true }
    return { ok: true, jkt: jwkThumbprint(header.jwk) }
  }

  private signJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
    const input = `${b64urlJson(header)}.${b64urlJson(payload)}`
    const signature = sign('sha256', Buffer.from(input), { key: this.signingKey, dsaEncoding: 'ieee-p1363' })
    return `${input}.${b64url(signature)}`
  }

  private json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}
