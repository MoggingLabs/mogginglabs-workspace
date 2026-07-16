import { ipcMain, shell, type BrowserWindow } from 'electron'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createPublicKey, verify as verifySignature, type JsonWebKey as CryptoJwk } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { AccountChannels, type AccountLoginResult, type AccountStatus } from '@contracts'
import { buildAuthorizeUrl, createPkce, createState, mergeRefreshedTokens, type AuthServerMetadata, type OAuthTokens } from '@backend/features/integrations'
import { generateDpopKey, loadDpopKey, openDeviceDpopKey, type DpopKey, type DpopKeyCustody } from '@backend/platform/dpop-key'
import { vaultAvailable, vaultClearKey, vaultHas, vaultLoad, vaultStore } from './vault'
import { getSettingsStore } from './app-settings'

// The account (ADR 0015) — the SOLE holder of our MoggingLabs credential. The app is
// a PUBLIC OAuth client (no secret in the bundle): login runs Authorization Code +
// PKCE(S256) in the user's OWN browser (shell.openExternal + an ephemeral 127.0.0.1
// loopback, RFC 8252 — the machinery connections.ts proved for ADR 0014), and every
// token request is DPoP-bound (RFC 9449) to a key pair this process holds.
//
// Custody, stated once and enforced by construction:
//   · the ACCESS token lives in memory only, and is read at exactly one point —
//     `accessTokenForEntitlement`, the single decrypt-and-use site;
//   · the REFRESH token rests ONLY as safeStorage ciphertext (vault.ts);
//   · the DPoP private key is the HARDWARE device key (step 06): non-exportable, chip-
//     resident (TPM / Secure Enclave), never in this process at all — so a refresh
//     token lifted from the vault, even decrypted, is INERT on any other machine (the
//     AS rejects a proof from a different key). Machines with no key store fall back
//     to the step-05 software key as vault ciphertext, surfaced as custody 'software'
//     (the honest downgrade — docs/18-accounts.md);
//   · NO IPC channel returns any of the three. `account:status` carries identity + plan
//     CLAIMS only. The write-only discipline (ADR 0014) is why a renderer bug cannot
//     leak a token: the surface has no getter to leak through.
//
// ADR 0002 is untouched: this is OUR credential, for entitlements — never a provider
// login, never a token that belongs to Claude/Codex/Gemini.

const VAULT_REFRESH = 'account.refresh' // the refresh token, ciphertext
const VAULT_DPOP = 'account.dpopKey' // the DPoP private key (PKCS8 PEM), ciphertext
const KV_EMAIL = 'account.email' // a claim — non-secret, plain KV (survives restart)
const KV_PLAN = 'account.plan' // a claim — non-secret, plain KV

/** What login talks to. In production this is the pinned MoggingLabs IdP (the reserved
 *  `idp` origin, ADR 0015 §6) — wired by the operator later; until then production has
 *  no config and login says so. The smoke injects a FAKE IdP config. Never read from
 *  the environment (ORIGINPIN). */
export interface AccountConfig {
  metadata: AuthServerMetadata
  clientId: string
  /** RFC 8707 audience — our entitlement API, so the token is bound to THIS resource. */
  resource: string
  scopes: string[]
}

let config: AccountConfig | null = null
let winGetter: (() => BrowserWindow | null) | null = null

// The access token: MEMORY ONLY, never persisted, never returned over IPC.
let access: { token: string; expiresAt?: number } | null = null
// The session generation. Bumped by every clearSession() (logout, a definitive AS
// rejection, an unusable grant) AND by every successful login persist — both doors
// supersede whatever was in flight. An in-flight refresh captures it before its network
// await and refuses to persist if it changed underneath — otherwise a logout that lands
// DURING a refresh's round-trip would be silently overwritten when the refresh resumes
// and re-vaults, resurrecting a session the user just ended. Single-threaded, so the
// only yield points are the awaits; the guard closes exactly that window.
let sessionEpoch = 0
// The explicit-logout generation — bumped ONLY by logout(), the user's own "done here"
// gesture (clearSession is also mechanical: a dying old session must not abandon the
// re-login that replaces it). A code exchange captures it at detach and refuses to
// persist if the user signed out underneath — otherwise "Sign out" clicked while a
// slow exchange was mid-flight got silently overridden seconds later.
let userLogoutEpoch = 0
// The DPoP key of record — the hardware device key when the machine has one, the
// vaulted software key otherwise. Resolved once, lazily, post-boot (I7); the resolving
// promise serializes concurrent first callers.
let dpopKey: DpopKey | null = null
let dpopKeyResolving: Promise<DpopKey | null> | null = null
// The AS-issued DPoP nonce, cached and reused until the AS rotates it (RFC 9449 §8).
let dpopNonce: string | undefined

// ── Test seams (production leaves all three untouched) ──────────────────────────────
type BrowserOpener = (url: string) => void | Promise<void>
let browserOpener: BrowserOpener = (url) => void shell.openExternal(url)
export function setAccountConfigForSmoke(cfg: AccountConfig | null): void {
  config = cfg
}
export function setBrowserOpenerForSmoke(opener: BrowserOpener | null): void {
  browserOpener = opener ?? ((url) => void shell.openExternal(url))
}

// ── Status: CLAIMS ONLY ─────────────────────────────────────────────────────────────
/** The whole outward truth of the account. Authed IFF a refresh token is vaulted — the
 *  ciphertext is the anchor; the claims are cached alongside it for an instant answer.
 *  Returns NO token, by construction (there is nowhere in this shape to put one). */
export function accountStatus(): AccountStatus {
  if (!vaultHas(VAULT_REFRESH)) return { state: 'anon' }
  const store = getSettingsStore()
  const email = store?.getSetting(KV_EMAIL) || undefined
  const plan = store?.getSetting(KV_PLAN) || undefined
  return { state: 'authed', email, plan }
}

/** Push the claims to the renderer. `reason` is the one transient human sentence a
 *  FAILED sign-in rides out on (AccountStatus.reason — push-only, never stored): a
 *  post-consent failure changes no state, so without it no push would fire and the
 *  browser tab would be the only witness. */
function pushStatus(reason?: string): void {
  const win = winGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(AccountChannels.changed, { ...accountStatus(), ...(reason ? { reason } : {}) })
  }
}

// ── The loopback redirect (RFC 8252), lifted from connections.ts ────────────────────
interface PendingFlow {
  state: string
  verifier: string
  redirectUri: string
  /** The whole config SNAPSHOT at flow start (resource for the exchange, issuer +
   *  jwks_uri + clientId for the id_token verify) — the callback never re-reads the
   *  (mutable) module config, so a config change mid-flow cannot throw or misbind. */
  cfg: AccountConfig
  /** The key this flow binds. Lives ON the flow (not module state) so a superseding
   *  login cannot hand a stale key to an older callback. Persisted only on success. */
  key: DpopKey
  server: Server
  timer: NodeJS.Timeout
  settle: (s: AccountStatus) => void
}
let pending: PendingFlow | null = null

const CLOSE_PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px/1.6 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee">` +
  `<div style="text-align:center;max-width:32rem"><h1 style="font-size:1.25rem">${title}</h1><p style="color:#aaa">${body}</p></div>`

function endFlow(): void {
  if (!pending) return
  clearTimeout(pending.timer)
  try {
    pending.server.close()
  } catch {
    /* already closing */
  }
  // Settle (idempotent) so a superseded or timed-out flow never strands an awaiter on
  // a promise nothing will ever resolve.
  pending.settle(accountStatus())
  pending = null
}

function startLoopback(onCode: (q: URLSearchParams, res: ServerResponse) => void): Promise<{ server: Server; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      onCode(url.searchParams, res)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, redirectUri: `http://127.0.0.1:${port}/callback` })
    })
  })
}

// ── DPoP-bound token requests (RFC 9449), with the nonce dance ──────────────────────
// `transient` marks COULD-NOT-REACH (offline, outage, DNS) as opposed to a definitive
// AS rejection: a rejection ends the session; unreachable must never — a paying user on
// a plane keeps their session exactly like they keep their grace-window plan (ADR 0015 §4).
type TokenResult = { ok: true; tokens: OAuthTokens } | { ok: false; reason: string; transient?: boolean }

async function dpopTokenRequest(form: Record<string, string>, key: DpopKey): Promise<TokenResult> {
  if (!config) return { ok: false, reason: 'no account config' }
  const endpoint = config.metadata.token_endpoint
  const clientId = config.clientId

  const attempt = async (): Promise<{ status: number; text: string; nonce: string | null }> => {
    const proof = await key.createProof({ htm: 'POST', htu: endpoint, nonce: dpopNonce })
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', DPoP: proof },
      body: new URLSearchParams({ ...form, client_id: clientId }),
      signal: AbortSignal.timeout(20_000)
    })
    return { status: res.status, text: await res.text(), nonce: res.headers.get('DPoP-Nonce') }
  }

  let r: { status: number; text: string; nonce: string | null }
  try {
    r = await attempt()
  } catch (e) {
    return { ok: false, reason: `Could not reach the account service: ${e instanceof Error ? e.message : String(e)}`, transient: true }
  }
  if (r.nonce) dpopNonce = r.nonce
  // RFC 9449 §8: the AS may demand a nonce it just handed us. Retry once, with it.
  if (r.status === 400 && /use_dpop_nonce/.test(r.text)) {
    try {
      r = await attempt()
    } catch (e) {
      return { ok: false, reason: `Could not reach the account service: ${e instanceof Error ? e.message : String(e)}`, transient: true }
    }
    if (r.nonce) dpopNonce = r.nonce
  }

  if (r.status < 200 || r.status >= 300) {
    let detail = String(r.status)
    try {
      const j = JSON.parse(r.text) as { error?: string; error_description?: string }
      detail = j.error_description ?? j.error ?? detail
    } catch {
      /* status stands */
    }
    // Definitive vs transient (RFC 6749 §5.2): only a 4xx OAuth answer (invalid_grant,
    // invalid_client…) means the GRANT is dead. A 5xx, a 429, or a nonce the AS rotated
    // twice mid-dance is the SERVICE having trouble — the same law as unreachable: no
    // token now, but the session survives and the vaulted grant retries later. Without
    // this line, one load-balancer 503 during an AS deploy signed out (and cleared the
    // vault of) every user whose refresh landed in that window.
    const transient = r.status >= 500 || r.status === 429 || /use_dpop_nonce/.test(r.text)
    return { ok: false, reason: String(detail).slice(0, 200), transient }
  }
  let j: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }
  try {
    j = JSON.parse(r.text)
  } catch {
    return { ok: false, reason: 'The account service did not return a token.' }
  }
  if (!j.access_token) return { ok: false, reason: 'The account service returned no access token.' }
  return {
    ok: true,
    tokens: {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      scopes: j.scope ? j.scope.split(/\s+/).filter(Boolean) : undefined,
      idToken: j.id_token
    }
  }
}

// ── OIDC id_token verification (OIDC Core §3.1.3.7, profiled for this client) ────────
const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

interface JwksKey {
  kty?: string
  kid?: string
  crv?: string
  x?: string
  y?: string
  n?: string
  e?: string
}

/** The id_token is VERIFIED against the AS's published JWKS before its claims are
 *  believed — signature (alg allowlisted to ES256/RS256 with the key TYPE required to
 *  match, RFC 8725 §3.1 — no `none`, no key confusion), `iss` (the metadata issuer),
 *  `aud` (this client), `exp` (2-minute skew). The claims are DISPLAY identity only
 *  (email + the marketing plan string; authorization never derives from them — the
 *  entitlement engine is the authority), so reachability follows the resilience law:
 *  a JWKS we cannot FETCH yields no claims and no failure ('unreachable'), while a
 *  token that is PRESENT and provably wrong ('invalid') is a tamper signal the login
 *  path refuses on. Never logs the token. */
type IdTokenVerdict = { ok: true; claims: { email?: string; plan?: string } } | { ok: false; why: 'unreachable' | 'invalid' }

async function verifyIdToken(idToken: string, cfg: AccountConfig): Promise<IdTokenVerdict> {
  const parts = idToken.split('.')
  if (parts.length !== 3) return { ok: false, why: 'invalid' }
  let header: { alg?: string; kid?: string }
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'))
    payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'))
  } catch {
    return { ok: false, why: 'invalid' }
  }
  if (header.alg !== 'ES256' && header.alg !== 'RS256') return { ok: false, why: 'invalid' }
  // No published keys = nothing verifiable — the claims stay absent rather than trusted.
  if (!cfg.metadata.jwks_uri) return { ok: false, why: 'unreachable' }
  let keys: JwksKey[]
  try {
    const res = await fetch(cfg.metadata.jwks_uri, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (res.status < 200 || res.status >= 300) return { ok: false, why: 'unreachable' }
    const doc = (await res.json()) as { keys?: JwksKey[] }
    keys = Array.isArray(doc.keys) ? doc.keys : []
  } catch {
    return { ok: false, why: 'unreachable' }
  }
  const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys.length === 1 ? keys[0] : undefined
  if (!jwk) return { ok: false, why: 'invalid' } // keys published, none matches — not our issuer's token
  if ((header.alg === 'ES256' && jwk.kty !== 'EC') || (header.alg === 'RS256' && jwk.kty !== 'RSA')) {
    return { ok: false, why: 'invalid' }
  }
  let ok = false
  try {
    const key = createPublicKey({ key: jwk as CryptoJwk, format: 'jwk' })
    const data = Buffer.from(`${parts[0]}.${parts[1]}`)
    const sig = b64urlToBuf(parts[2])
    // ES256 signs raw r‖s (ieee-p1363); RS256 is PKCS#1 v1.5, node's RSA default.
    ok = header.alg === 'ES256' ? verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) : verifySignature('sha256', data, key, sig)
  } catch {
    return { ok: false, why: 'invalid' }
  }
  if (!ok) return { ok: false, why: 'invalid' }
  const aud = payload.aud
  const audOk = aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId))
  const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : 0
  if (payload.iss !== cfg.metadata.issuer || !audOk || exp * 1000 <= Date.now() - 120_000) return { ok: false, why: 'invalid' }
  return {
    ok: true,
    claims: {
      email: typeof payload.email === 'string' ? payload.email : undefined,
      plan: typeof payload.plan === 'string' ? payload.plan : undefined
    }
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────────────
/** `claims` are the VERIFIED id_token claims (verifyIdToken) — callers pass undefined
 *  when there was no id_token or its JWKS was unreachable, and the stored claims stand. */
function persistGrant(tokens: OAuthTokens, key: DpopKey, claims?: { email?: string; plan?: string }): boolean {
  // The refresh token must land as ciphertext or we hold nothing (never plaintext at
  // rest — ADR 0008.h). The DPoP key persists only in the SOFTWARE fallback custody:
  // a hardware key has no exportable private half — the chip IS its persistence. The
  // PEM is (re)written on every grant persist — not only when the slot is empty — so a
  // corrupt or stale slot heals at the next login instead of stranding the session at
  // the next restart (the key in use and the key at rest must be the same key).
  if (tokens.refreshToken && !vaultStore(VAULT_REFRESH, tokens.refreshToken)) return false
  if (key.exportPrivateKeyPem && !vaultStore(VAULT_DPOP, key.exportPrivateKeyPem())) return false
  const store = getSettingsStore()
  if (claims?.email !== undefined) store?.setSetting(KV_EMAIL, claims.email)
  if (claims?.plan !== undefined) store?.setSetting(KV_PLAN, claims.plan)
  return true
}

/** The platform key store exists but ERRORED (a TPM after sleep/resume, a busy
 *  enclave). Distinct BY TYPE from "this machine has no key store" (null): unavailable
 *  means try again later — a refresh keeps the session, a login refuses with a reason —
 *  never a silent fall-through to the software key. Treating chip trouble as chip
 *  absence minted software keys on chip machines at login (a custody downgrade whose
 *  proofs the AS later refuses as a foreign key) and ended sessions at refresh. */
class DeviceKeyUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`device key store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'DeviceKeyUnavailableError'
  }
}

/** The key of record. HARDWARE FIRST: the device key binds the session to this
 *  physical machine (a stale software PEM in the vault is deliberately ignored when a
 *  chip exists — it is the exportable thing step 06 retires). Software fallback only
 *  when the machine HAS no key store (openDeviceDpopKey's null), and only if a vaulted
 *  PEM exists; null means "no key yet" and login mints one. A key store that ERRORED
 *  throws DeviceKeyUnavailableError instead — absence and unavailability must never
 *  read the same. */
async function currentDpopKey(): Promise<DpopKey | null> {
  if (dpopKey) return dpopKey
  if (!dpopKeyResolving) {
    dpopKeyResolving = (async (): Promise<DpopKey | null> => {
      let hw: DpopKey | null
      try {
        hw = await openDeviceDpopKey()
      } catch (e) {
        // The chip is present but unhappy (native-preflight already failed the boot if
        // the ADDON cannot load, so this is runtime store trouble). Not cached: the
        // resolving slot clears in finally and the next caller asks the chip afresh.
        throw new DeviceKeyUnavailableError(e)
      }
      if (hw) return (dpopKey = hw)
      const pem = vaultLoad(VAULT_DPOP)
      if (!pem) return null
      try {
        return (dpopKey = loadDpopKey(pem))
      } catch {
        return null // an unreadable vaulted PEM is no key; login mints (and re-vaults) a fresh one
      }
    })().finally(() => {
      dpopKeyResolving = null
    })
  }
  return dpopKeyResolving
}

function clearSession(): void {
  sessionEpoch += 1 // any in-flight refresh that predates this must not re-persist
  vaultClearKey(VAULT_REFRESH)
  vaultClearKey(VAULT_DPOP)
  const store = getSettingsStore()
  store?.setSetting(KV_EMAIL, '')
  store?.setSetting(KV_PLAN, '')
  access = null
  // Drop the in-memory handle only. The DEVICE key stays in the chip across logouts —
  // it is the machine's identity, not the session's; the next login re-binds to it.
  dpopKey = null
  dpopKeyResolving = null
}

// ── Login ───────────────────────────────────────────────────────────────────────────
/** Start an OAuth flow. Resolves when the BROWSER has been opened — not when the user
 *  finishes (a human at a consent screen is not something an IPC call may block on;
 *  the real answer arrives over `account:changed`). Never on the boot path (I7). */
export async function login(): Promise<AccountLoginResult> {
  const cfg = config
  if (!cfg) return { ok: false, reason: 'Account sign-in is not available in this build yet.' }
  if (!vaultAvailable()) return { ok: false, reason: 'No OS keychain — cannot hold your session securely. Sign-in is disabled.' }
  if (pending) endFlow() // supersede any half-finished flow (endFlow settles its awaiter)

  const pkce = createPkce()
  const state = createState()
  // The device key (or, fallback custody, the persisted software key) is reused across
  // logins so the binding survives a re-auth; a software key is minted only when the
  // machine has NEITHER. A key store that ERRORED refuses the login honestly — minting
  // a software key on a chip machine would silently downgrade custody for the whole
  // session, and the chip's own next answer would then read the grant as foreign.
  let key: DpopKey
  try {
    key = (await currentDpopKey()) ?? generateDpopKey()
  } catch {
    return { ok: false, reason: 'Your device key store is not answering right now. Try signing in again in a moment.' }
  }

  let loop: { server: Server; redirectUri: string }
  try {
    loop = await startLoopback((q, res) => void handleCallback(q, res))
  } catch {
    return { ok: false, reason: 'Could not open a local port to receive the sign-in.' }
  }

  const settled = new Promise<AccountStatus>((resolve) => {
    const timer = setTimeout(() => endFlow(), 5 * 60_000) // endFlow settles via the flow record
    pending = { state, verifier: pkce.verifier, redirectUri: loop.redirectUri, cfg, key, server: loop.server, timer, settle: resolve }
  })

  const authorizeUrl = buildAuthorizeUrl({
    metadata: cfg.metadata,
    clientId: cfg.clientId,
    redirectUri: loop.redirectUri,
    resource: cfg.resource,
    challenge: pkce.challenge,
    state,
    scopes: cfg.scopes
  })
  try {
    await browserOpener(authorizeUrl)
  } catch (e) {
    endFlow()
    return { ok: false, reason: `Could not open your browser: ${e instanceof Error ? e.message : String(e)}` }
  }
  // The real answer lands over `account:changed`; the smoke awaits `whenSettledForSmoke`.
  lastSettled = settled
  return { ok: true }
}

let lastSettled: Promise<AccountStatus> | null = null

async function handleCallback(q: URLSearchParams, res: ServerResponse): Promise<void> {
  if (!pending) {
    res.writeHead(400).end()
    return
  }
  const flow = pending
  if (q.get('state') !== flow.state) {
    // Not OUR redirect (CSRF garbage on the loopback port): refuse this request but
    // keep the flow alive for the real callback.
    res.writeHead(400, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Sign-in failed', 'The response did not match our request.'))
    return
  }
  const error = q.get('error')
  if (error) {
    res.writeHead(200, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Sign-in cancelled', 'You can close this tab.'))
    endFlow() // settles the flow
    pushStatus()
    return
  }
  const code = q.get('code')
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Sign-in failed', 'No authorization code was returned.'))
    endFlow()
    return
  }
  // DETACH the flow before the exchange: no second callback may race this one (the
  // code is single-use), but the response socket stays open — the page below reports
  // what actually HAPPENED. The old order answered "Signed in" before the exchange,
  // so a refused exchange left a lying browser tab and a silent app.
  clearTimeout(flow.timer)
  pending = null
  const logoutEpochAtDetach = userLogoutEpoch
  const finish = (title: string, body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(CLOSE_PAGE(title, body))
    try {
      flow.server.close()
    } catch {
      /* already closing */
    }
  }
  const fail = (why: string): void => {
    finish('Sign-in failed', 'Return to the app and try again.')
    pushStatus(why) // the one transient sentence the account panel toasts
    flow.settle(accountStatus())
  }

  const exchanged = await dpopTokenRequest(
    { grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, resource: flow.cfg.resource },
    flow.key
  )
  if (!exchanged.ok) {
    fail(`The account service refused the sign-in: ${exchanged.reason}`)
    return
  }
  // A grant without a refresh token cannot be HELD (the vaulted refresh token is the
  // session anchor status reads): accepting one would leave a phantom session — an
  // access token working in memory under an 'anon' status. The operator's IdP contract
  // requires offline_access-shaped grants; refusing here pins that in code.
  if (!exchanged.tokens.refreshToken) {
    fail('The account service returned no refresh token, so the session could not be kept.')
    return
  }
  // OIDC: identity claims are believed only after verifyIdToken (signature against the
  // published JWKS + iss/aud/exp). A JWKS blip costs the display claims, not the login;
  // a PRESENT-but-INVALID token is a tamper signal and refuses the login outright.
  let claims: { email?: string; plan?: string } | undefined
  if (exchanged.tokens.idToken) {
    const v = await verifyIdToken(exchanged.tokens.idToken, flow.cfg)
    if (!v.ok && v.why === 'invalid') {
      fail('The account service returned an identity token that failed verification, so sign-in was abandoned.')
      return
    }
    if (v.ok) claims = v.claims
  }
  // The user's LAST word wins: a Sign out clicked while this exchange was on the wire
  // means the machine stays anon-Free — persisting now would override the one-gesture
  // logout law seconds after the gesture.
  if (logoutEpochAtDetach !== userLogoutEpoch) {
    fail('You signed out while the sign-in was completing, so it was abandoned.')
    return
  }
  if (!persistGrant(exchanged.tokens, flow.key, claims)) {
    clearSession()
    fail('Could not store your session securely, so sign-in was abandoned.')
    return
  }
  // The NEW session supersedes everything in flight: an old-session refresh resuming
  // after this persist must not re-vault over it (the logout epoch law, from the other
  // direction — clearSession bumps on the way out, a fresh grant bumps on the way in).
  sessionEpoch += 1
  dpopKey = flow.key
  access = { token: exchanged.tokens.accessToken, expiresAt: exchanged.tokens.expiresAt }
  finish('Signed in', 'You can close this tab and return to the app.')
  pushStatus()
  try {
    onLogin?.()
  } catch {
    /* a hook must never break login */
  }
  flow.settle(accountStatus())
}

// ── Refresh: serialized per account (the ADR 0014 promise-map pattern) ──────────────
const refreshing = new Map<string, Promise<string | null>>()
const ACCOUNT_KEY = 'self' // one account today; the map keeps the rotation-safe shape

/** The access token for an outbound ENTITLEMENT call — the ONE place token material is
 *  decrypted and used, and it never leaves this module (no caller receives it raw over
 *  IPC). Refreshes with a minute of slack so an in-flight call cannot expire mid-request. */
export async function accessTokenForEntitlement(): Promise<string | null> {
  if (access && (!access.expiresAt || access.expiresAt - Date.now() > 60_000)) return access.token
  if (!vaultHas(VAULT_REFRESH)) return null
  const inflight = refreshing.get(ACCOUNT_KEY)
  if (inflight) return inflight
  const run = doRefresh().finally(() => refreshing.delete(ACCOUNT_KEY))
  refreshing.set(ACCOUNT_KEY, run)
  return run
}

async function doRefresh(): Promise<string | null> {
  const cfg = config
  // No config with a vaulted grant is the ROLLBACK shape (an update shipped config-less
  // over a signed-in install): nothing to talk to, but nothing was REJECTED either —
  // the session stands and simply cannot refresh until config returns. (The old
  // `config!.resource` threw here instead of answering.)
  if (!cfg) return null
  const epoch = sessionEpoch // the session this refresh belongs to
  const rt = vaultLoad(VAULT_REFRESH)
  let key: DpopKey | null
  try {
    key = await currentDpopKey()
  } catch {
    // The key STORE errored (a TPM asleep, a busy enclave) — the key still exists, we
    // just cannot reach it right now: no token, session kept, the next call retries.
    // Only "no key EXISTS" below is the unusable grant that ends a session.
    return null
  }
  if (!rt || !key) {
    // No key means an unusable grant (another machine, or a cleared vault) — drop to
    // anon cleanly rather than pretend.
    clearSession()
    pushStatus()
    return null
  }
  const next = await dpopTokenRequest({ grant_type: 'refresh_token', refresh_token: rt, resource: cfg.resource }, key)
  if (!next.ok) {
    // UNREACHABLE is not REJECTED: an outage (ours or the plane's) yields no token but
    // KEEPS the session — the vaulted grant retries next time, and the cached
    // entitlement's grace math never depended on being freshly signed in. Only a
    // definitive AS rejection (revoked, expired, foreign-key) ends the session cleanly.
    if (next.transient) return null
    clearSession()
    pushStatus()
    return null
  }
  // OIDC on refresh, softer than login BY DESIGN: an id_token that fails to verify (or
  // whose JWKS is unreachable) simply does not UPDATE the stored claims — the grant
  // itself is fine, and ending a paying user's session over an ancillary display token
  // is the overreaction the 5xx law exists to prevent. Login is the strict gate.
  let claims: { email?: string; plan?: string } | undefined
  if (next.tokens.idToken) {
    const v = await verifyIdToken(next.tokens.idToken, cfg)
    if (v.ok) claims = v.claims
  }
  // A logout (or another session-clear) that landed while we were awaiting the AS wins:
  // do NOT re-vault a grant the user just ended. The AS already rotated the presented
  // refresh token, so the newly-issued one is simply dropped — the session stays ended.
  // (Checked AFTER the verify await — the guard must be the LAST thing before persist.)
  if (epoch !== sessionEpoch) return null
  // ROTATION: persist the NEW refresh token (many AS rotate on every use; dropping it
  // strands the grant at the next expiry). mergeRefreshedTokens keeps the old one only
  // when the AS returned none.
  const merged = mergeRefreshedTokens({ accessToken: access?.token ?? '', refreshToken: rt }, next.tokens)
  if (!persistGrant(merged, key, claims)) {
    clearSession()
    pushStatus()
    return null
  }
  access = { token: next.tokens.accessToken, expiresAt: next.tokens.expiresAt }
  pushStatus()
  return next.tokens.accessToken
}

/** A DPoP proof for a RESOURCE-SERVER call (the entitlement fetch): binds the proof to
 *  the presented access token via its hash (RFC 9449 `ath`), and carries the RS-issued
 *  nonce when the caller is answering a §8.2 challenge. The proof is a PUBLIC JWT —
 *  the private key never enters this process (hardware) or leaves this module
 *  (software fallback), so custody is unchanged. Null when no session key exists OR
 *  the key store is temporarily unreachable — either way the caller refuses the call
 *  and the cache/grace math stands. */
export async function dpopProofForResource(htm: string, htu: string, accessToken: string, nonce?: string): Promise<string | null> {
  let key: DpopKey | null
  try {
    key = await currentDpopKey()
  } catch {
    return null
  }
  if (!key) return null
  return key.createProof({ htm, htu, accessToken, nonce })
}

/** The RFC 7638 thumbprint of the key of record — the device identity entitlements
 *  attest to and verify against (step 06). A PUBLIC value, never a secret. Opens
 *  (creating on first use) the device key, so callers invoke it lazily, post-boot.
 *  Null when no key exists or the store is temporarily unreachable. */
export async function deviceBindingJkt(): Promise<string | null> {
  try {
    return (await currentDpopKey())?.jkt ?? null
  } catch {
    return null
  }
}

// ── Logout ──────────────────────────────────────────────────────────────────────────
// Explicit user logout ALSO drops the cached entitlement (the hook below — installed by
// registerEntitlements, which already imports this module, so no cycle). Deliberately
// NOT part of clearSession(): a session that dies under us (revoked refresh, a copied
// vault on foreign hardware) must leave the cache in place — the device-mismatch story
// and its telemetry read it, and grace math never depended on being signed in. Logout
// is the one door where the USER said "done here", so the machine returns to anon-FREE.
let onLogout: (() => void) | null = null
export function setAccountLogoutHook(cb: (() => void) | null): void {
  onLogout = cb
}

// The mirror door, for LOGIN: a fresh session should ask the issuer for its plan NOW —
// without this, the entitlement engine's only fetch trigger was the renderer-mount
// snapshot pull, so the plan a user just signed in for (or just paid for) waited for
// the next app restart to land. Wired by registerEntitlements, same as the logout hook.
let onLogin: (() => void) | null = null
export function setAccountLoginHook(cb: (() => void) | null): void {
  onLogin = cb
}

export async function logout(): Promise<void> {
  userLogoutEpoch += 1 // the explicit gesture — a mid-flight exchange must not override it
  if (pending) endFlow()
  // RFC 7009, best-effort and NON-BLOCKING: the grant this machine is about to forget
  // is also revoked AT the AS, so a vaulted-then-forgotten refresh token is not left
  // valid server-side. Fire-and-forget by design — logout is instant and works offline
  // (§2.2: even the AS answers 200 for unknown tokens, so there is nothing to wait on);
  // the AS's rotation + reuse detection remains the backstop when this misses. The
  // plaintext read is a point-of-use decrypt, custody unchanged (ADR 0015 §3).
  const cfg = config
  const rt = vaultLoad(VAULT_REFRESH)
  if (cfg?.metadata.revocation_endpoint && rt) {
    void fetch(cfg.metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rt, token_type_hint: 'refresh_token', client_id: cfg.clientId }),
      signal: AbortSignal.timeout(10_000)
    }).catch(() => undefined)
  }
  clearSession()
  dpopNonce = undefined
  try {
    onLogout?.()
  } catch {
    /* a hook must never break logout */
  }
  pushStatus()
}

// ── Smoke-only helpers (never wired in production; no token ever returned) ──────────
export function whenSettledForSmoke(): Promise<AccountStatus> | null {
  return lastSettled
}
/** Force the access token stale and run the refresh path. Returns success + whether the
 *  session is still authed — NEVER the token. */
export async function forceRefreshForSmoke(): Promise<{ ok: boolean; authed: boolean }> {
  if (access) access.expiresAt = Date.now() - 1
  const t = await accessTokenForEntitlement()
  return { ok: t !== null, authed: accountStatus().state === 'authed' }
}
/** The jkt the current DPoP key advertises — a public thumbprint, not a secret. Lets
 *  the smoke prove the AS bound the SAME key it holds. */
export function dpopJktForSmoke(): Promise<string | null> {
  return deviceBindingJkt()
}
/** Where the key of record lives ('tpm' | 'cng' | 'secure-enclave' | 'software') —
 *  the DEVICEKEY smoke's honesty probe. Null when no key exists yet (or the store is
 *  unreachable, the same refusal production callers get). */
export async function dpopCustodyForSmoke(): Promise<DpopKeyCustody | null> {
  try {
    return (await currentDpopKey())?.custody ?? null
  } catch {
    return null
  }
}
/** Simulate a process on ANOTHER machine: everything in-memory is gone (the key
 *  handle, the access token) while the vault contents — what a pirated copy carries —
 *  survive. The next key resolution asks the (smoke-renamed) chip afresh. */
export function dropDpopKeyMemoryForSmoke(): void {
  dpopKey = null
  dpopKeyResolving = null
  access = null
}
export function resetAccountForSmoke(): void {
  clearSession()
  dpopNonce = undefined
  config = null
  browserOpener = (url) => void shell.openExternal(url)
}

// ── IPC surface: status / login / logout. NO token getter, by construction. ─────────
export function registerAccount(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  ipcMain.handle(AccountChannels.status, () => accountStatus())
  ipcMain.handle(AccountChannels.login, () => login())
  ipcMain.handle(AccountChannels.logout, () => logout())
}
