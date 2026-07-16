import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type JsonWebKey as CryptoJwk,
  type KeyObject
} from 'node:crypto'
import { deriveWatermark } from './watermark'

// A deterministic, in-process ENTITLEMENT issuer (phase-accounts/05) — the ONLY signer
// the smoke ever touches (zero external network, by construction; the fake-idp
// pattern). The real MoggingLabs entitlement service is the operator's later wiring;
// src/main/entitlements.ts talks to whichever baseUrl it is handed and verifies with
// whichever pinned key the build carries — the smoke hands it THIS server and THIS
// server's public key, as call-site parameters (never the environment; ORIGINPIN).
//
// It is a real HTTP server for the part the client exercises for real — GET
// /entitlement with the step-04 access token + a DPoP proof — so the production fetch
// path (headers, `ath` binding, JSON envelope, verify-then-cache) runs unmodified.
// The proof check here is what lets the smoke PROVE the authn rides along: signature
// valid, htm/htu right, and `ath` equal to the hash of the exact token presented.
//
// Fixtures cover the whole verification lattice: Free, Pro, expired-at-fetch,
// short-TTL (the smoke ages it into grace with the client clock seam), tampered
// payload, wrong-key signature, and device-mismatch — the last is CARRIED today and
// consumed by step 06 (hardware binding), so it must exist before it is enforced.

export type FakeEntitleFixture = 'free' | 'pro' | 'expired' | 'in-grace' | 'tampered' | 'wrong-key' | 'device-mismatch' | 'revoked'

export interface FakeEntitleOptions {
  /** The deviceId a well-issued entitlement carries. OMIT to bind each HTTP-issued
   *  entitlement to the presented DPoP proof's own key thumbprint — the step-06
   *  attestation shape: the request carries the device public key (the proof's
   *  header jwk) and the issuer sender-constrains the claim to it. An explicit value
   *  pins every fixture to that id instead (the pre-06 smokes). */
  deviceId?: string
  /** Pro-tier limits{} to embed — the smoke uses a LOW row to prove a gate bites. */
  proLimits?: Record<string, number>
  proFeatures?: string[]
  /** TTL seconds for the fresh fixtures (spec range: 24–72h). */
  ttlSec?: number
  /** The clock claims are minted against — share the smoke's seam so iat/exp and the
   *  client's grace math tell one story. */
  clock?: () => number
  /** The account this issuer activates for — the subject of the forensic watermark
   *  (phase-accounts/07). When set, every fresh fixture carries `accountId` + the derived
   *  watermark carriers. Omit for the pre-07 smokes (no watermark on the claim). */
  accountId?: string
  /** FAKE merchant-of-record wiring (phase-accounts/10). When set, the issuer models the
   *  real server pair: SUBSCRIPTION STATE lives here (server value, ADR 0015 §5), starts
   *  'free', and flips to 'pro' only when a signed MoR webhook (POST /mor/webhook,
   *  HMAC-SHA256 over the raw body in the `mor-signature` header — the Paddle/Stripe
   *  shape) delivers `subscription.activated`. A wrong signature is refused and flips
   *  nothing — faking the webhook is exactly the crack the signature exists to stop.
   *  The real MoR + issuer are the operator's later wiring; this pins their contract. */
  morWebhookSecret?: string
}

const b64url = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJson = (o: unknown): string => b64url(JSON.stringify(o))
const b64urlDecode = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

export class FakeEntitleIssuer {
  private server: Server | null = null
  private port = 0
  private readonly signingKey: KeyObject
  /** The verify key the smoke injects into the client — the fixture stand-in for the
   *  pinned production key. */
  readonly publicKeyPem: string
  private readonly foreignKey: KeyObject // signs the wrong-key fixture
  private readonly explicitDeviceId: string | null
  /** The key thumbprint of the last VERIFIED proof — what an omitted-deviceId issuer
   *  binds to (device attestation at issuance, step 06). */
  lastProofJkt: string | null = null
  private readonly proLimits: Record<string, number>
  private readonly proFeatures: string[]
  private readonly ttlSec: number
  private readonly clock: () => number
  private readonly accountId: string | null
  private readonly morWebhookSecret: string | null

  private fixture: FakeEntitleFixture = 'pro'

  // Introspection — for the smoke only, never touched by production.
  entitlementRequests = 0
  proofsVerified = 0
  lastAuthOk: boolean | null = null
  lastAthOk: boolean | null = null
  /** MoR webhook introspection: verified deliveries, and refused (bad-signature) ones. */
  webhookDeliveries = 0
  webhookRefusals = 0

  constructor(opts: FakeEntitleOptions = {}) {
    this.explicitDeviceId = opts.deviceId ?? null
    this.proLimits = opts.proLimits ?? { maxPanes: 16, maxConnections: 25, maxSwarmRoles: 16, maxRemotes: 10 }
    this.proFeatures = opts.proFeatures ?? ['pro']
    this.ttlSec = opts.ttlSec ?? 48 * 3600
    this.clock = opts.clock ?? Date.now
    this.accountId = opts.accountId ?? null
    this.morWebhookSecret = opts.morWebhookSecret ?? null
    // MoR mode: subscription state is SERVER value — nobody is Pro until the webhook says so.
    if (this.morWebhookSecret) this.fixture = 'free'
    const pair = generateKeyPairSync('ed25519')
    this.signingKey = pair.privateKey
    this.publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    this.foreignKey = generateKeyPairSync('ed25519').privateKey
  }

  setFixture(f: FakeEntitleFixture): void {
    this.fixture = f
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.route(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as AddressInfo).port
        resolve()
      })
    })
  }

  /** Stopping the server IS the smoke's "pull the network": the next client fetch
   *  fails at connect, and the cached claim + grace math must carry the app. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      // Drop undici's idle keep-alive sockets, or close() waits out their timeout —
      // the smoke stops this server MID-RUN, not just at teardown.
      this.server.closeIdleConnections()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  /** What a well-issued claim is bound to: the pinned fixture id, or — attestation —
   *  the device key that signed the last verified proof. */
  private boundDeviceId(): string {
    return this.explicitDeviceId ?? this.lastProofJkt ?? 'device-1'
  }

  /** Mint a fixture directly (no HTTP) — the smoke feeds tampered/wrong-key/expired
   *  tokens straight to the client verifier too, so rejection is proven at the exact
   *  function production trusts. */
  issue(fixture: FakeEntitleFixture = this.fixture): string {
    const nowSec = Math.floor(this.clock() / 1000)
    const base = { deviceId: this.boundDeviceId(), iat: nowSec, exp: nowSec + this.ttlSec }
    // The forensic activation watermark (phase-accounts/07): when this issuer activates
    // for a known account, every FRESH, well-issued fixture carries `accountId` + the
    // derived carriers — signed in place, so an edit invalidates the whole claim.
    const mark = this.accountId ? { accountId: this.accountId, watermark: deriveWatermark(this.accountId) } : {}
    switch (fixture) {
      case 'free':
        return this.signJwt({ plan: 'free', features: [], limits: {}, ...base })
      case 'pro':
        return this.signJwt({ plan: 'pro', features: this.proFeatures, limits: this.proLimits, ...mark, ...base })
      case 'revoked':
        // Validly signed, watermarked — but the account is revoked server-side. The
        // engine honors the `revoked` claim and degrades to Free on the next refresh
        // (no remote detonation of a running app).
        return this.signJwt({ plan: 'pro', features: this.proFeatures, limits: this.proLimits, ...mark, ...base, revoked: true })
      case 'expired':
        // Stale ON ARRIVAL: exp already behind the shared clock — the client must
        // treat the fetch as having returned nothing.
        return this.signJwt({ plan: 'pro', features: this.proFeatures, limits: this.proLimits, ...base, iat: nowSec - 7200, exp: nowSec - 3600 })
      case 'in-grace':
        // Fresh for one hour; the smoke then advances the client clock past exp (but
        // inside the grace window) — grace is CACHE aging, not an issuer state.
        return this.signJwt({ plan: 'pro', features: this.proFeatures, limits: this.proLimits, ...base, exp: nowSec + 3600 })
      case 'tampered': {
        // Properly signed, then the payload edited after the fact — the signature no
        // longer covers what the claims say (the classic local-crack shape).
        const good = this.signJwt({ plan: 'free', features: [], limits: {}, ...base })
        const [h, p, s] = good.split('.')
        const claims = JSON.parse(b64urlDecode(p)) as Record<string, unknown>
        claims.plan = 'pro'
        return `${h}.${b64urlJson(claims)}.${s}`
      }
      case 'wrong-key':
        // A perfectly well-formed claim from a signer that is not ours.
        return this.signJwt({ plan: 'pro', features: this.proFeatures, limits: this.proLimits, ...base }, this.foreignKey)
      case 'device-mismatch':
        // Valid signature, someone else's machine. Step 06 (hardware binding) turned
        // this from a carried claim into a refusal — the engine never caches it.
        return this.signJwt({ plan: 'pro', features: this.proFeatures, limits: this.proLimits, ...base, deviceId: `not-${this.boundDeviceId()}-${b64url(randomBytes(6))}` })
    }
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.baseUrl)
    if (req.method === 'GET' && url.pathname === '/entitlement') return this.entitlement(req, res)
    if (req.method === 'POST' && url.pathname === '/mor/webhook' && this.morWebhookSecret) return this.morWebhook(req, res)
    res.writeHead(404).end()
  }

  /** The FAKE MoR → issuer webhook: `subscription.activated` flips the account's plan
   *  server-side — the client never asserts Pro, it only fetches what the server now
   *  says. Signature first (HMAC over the RAW body), state change second, exactly the
   *  order the operator's real handler must keep. */
  private morWebhook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const presented = Buffer.from(String(req.headers['mor-signature'] ?? ''), 'utf8')
      const expected = Buffer.from(createHmac('sha256', this.morWebhookSecret!).update(raw).digest('hex'), 'utf8')
      const sigOk = presented.length === expected.length && timingSafeEqual(presented, expected)
      if (!sigOk) {
        this.webhookRefusals += 1
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_signature' }))
        return
      }
      let event: { type?: unknown } = {}
      try {
        event = JSON.parse(raw.toString('utf8')) as { type?: unknown }
      } catch {
        /* shape check below refuses it */
      }
      if (event.type !== 'subscription.activated' && event.type !== 'subscription.canceled') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown_event' }))
        return
      }
      this.webhookDeliveries += 1
      this.fixture = event.type === 'subscription.activated' ? 'pro' : 'free'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ received: true }))
    })
  }

  private entitlement(req: IncomingMessage, res: ServerResponse): void {
    this.entitlementRequests += 1
    const auth = String(req.headers['authorization'] ?? '')
    const token = auth.startsWith('DPoP ') ? auth.slice(5) : ''
    const proofOk = token ? this.verifyDpop(String(req.headers['dpop'] ?? ''), token) : false
    this.lastAuthOk = !!token && proofOk
    if (!this.lastAuthOk) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_token', error_description: 'DPoP-bound access token required' }))
      return
    }
    this.proofsVerified += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ entitlement: this.issue() }))
  }

  /** RFC 9449 resource-server check: proof signature by the embedded jwk, htm/htu of
   *  THIS request, and `ath` = hash of the exact access token presented. */
  private verifyDpop(proof: string, accessToken: string): boolean {
    const parts = proof.split('.')
    if (parts.length !== 3) return false
    let header: { typ?: string; alg?: string; jwk?: Record<string, unknown> }
    let payload: { htm?: string; htu?: string; ath?: string }
    try {
      header = JSON.parse(b64urlDecode(parts[0]))
      payload = JSON.parse(b64urlDecode(parts[1]))
    } catch {
      return false
    }
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || !header.jwk) return false
    if (payload.htm !== 'GET' || payload.htu !== `${this.baseUrl}/entitlement`) return false
    let pub: KeyObject
    try {
      pub = createPublicKey({ key: header.jwk as unknown as CryptoJwk, format: 'jwk' })
    } catch {
      return false
    }
    const sigOk = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(parts[2]))
    if (!sigOk) return false
    this.lastAthOk = payload.ath === b64url(createHash('sha256').update(accessToken).digest())
    if (this.lastAthOk) {
      // Attestation: the VERIFIED proof's own key is the device this issuer binds to
      // (RFC 7638 thumbprint of the header jwk — the client's device public key).
      const j = header.jwk as { kty?: string; crv?: string; x?: string; y?: string }
      this.lastProofJkt = b64url(
        createHash('sha256').update(`{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`).digest()
      )
    }
    return this.lastAthOk
  }

  private signJwt(payload: Record<string, unknown>, key: KeyObject = this.signingKey): string {
    const input = `${b64urlJson({ alg: 'EdDSA', typ: 'entitle+jwt' })}.${b64urlJson(payload)}`
    // Ed25519: algorithm null, the key decides.
    return `${input}.${b64url(sign(null, Buffer.from(input), key))}`
  }
}
