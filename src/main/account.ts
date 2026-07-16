import { ipcMain, shell, type BrowserWindow } from 'electron'
import { createServer, type Server, type ServerResponse } from 'node:http'
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

function pushStatus(): void {
  const win = winGetter?.()
  if (win && !win.isDestroyed()) win.webContents.send(AccountChannels.changed, accountStatus())
}

// ── The loopback redirect (RFC 8252), lifted from connections.ts ────────────────────
interface PendingFlow {
  state: string
  verifier: string
  redirectUri: string
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
    return { ok: false, reason: String(detail).slice(0, 200) }
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

/** Decode (not verify) the id_token payload for its identity + plan claims. The token
 *  arrived over a channel we initiated from a code only we hold; JWKS signature
 *  verification is a later hardening. Never logs the token. */
function claimsFromIdToken(idToken: string | undefined): { email?: string; plan?: string } {
  if (!idToken) return {}
  const parts = idToken.split('.')
  if (parts.length < 2) return {}
  try {
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      email?: unknown
      plan?: unknown
    }
    return {
      email: typeof p.email === 'string' ? p.email : undefined,
      plan: typeof p.plan === 'string' ? p.plan : undefined
    }
  } catch {
    return {}
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────────────
function persistGrant(tokens: OAuthTokens, key: DpopKey): boolean {
  // The refresh token must land as ciphertext or we hold nothing (never plaintext at
  // rest — ADR 0008.h). The DPoP key persists only in the SOFTWARE fallback custody:
  // a hardware key has no exportable private half — the chip IS its persistence.
  if (tokens.refreshToken && !vaultStore(VAULT_REFRESH, tokens.refreshToken)) return false
  if (key.exportPrivateKeyPem && !vaultHas(VAULT_DPOP) && !vaultStore(VAULT_DPOP, key.exportPrivateKeyPem())) return false
  const claims = claimsFromIdToken(tokens.idToken)
  const store = getSettingsStore()
  if (claims.email !== undefined) store?.setSetting(KV_EMAIL, claims.email)
  if (claims.plan !== undefined) store?.setSetting(KV_PLAN, claims.plan)
  return true
}

/** The key of record. HARDWARE FIRST: the device key binds the session to this
 *  physical machine (a stale software PEM in the vault is deliberately ignored when a
 *  chip exists — it is the exportable thing step 06 retires). Software fallback only
 *  when the machine has no key store, and only if a vaulted PEM exists; null means
 *  "no key yet" and login mints one. */
async function currentDpopKey(): Promise<DpopKey | null> {
  if (dpopKey) return dpopKey
  if (!dpopKeyResolving) {
    dpopKeyResolving = (async (): Promise<DpopKey | null> => {
      try {
        const hw = await openDeviceDpopKey()
        if (hw) return (dpopKey = hw)
      } catch {
        // Addon trouble must degrade to the software path, never brick sign-in;
        // native-preflight already failed the boot loudly if the addon cannot load.
      }
      const pem = vaultLoad(VAULT_DPOP)
      if (!pem) return null
      try {
        return (dpopKey = loadDpopKey(pem))
      } catch {
        return null
      }
    })().finally(() => {
      dpopKeyResolving = null
    })
  }
  return dpopKeyResolving
}

function clearSession(): void {
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
  if (!config) return { ok: false, reason: 'Account sign-in is not available in this build yet.' }
  if (!vaultAvailable()) return { ok: false, reason: 'No OS keychain — cannot hold your session securely. Sign-in is disabled.' }
  if (pending) endFlow() // supersede any half-finished flow

  const pkce = createPkce()
  const state = createState()
  // The device key (or, fallback custody, the persisted software key) is reused across
  // logins so the binding survives a re-auth; a software key is minted only when the
  // machine has neither.
  const key = (await currentDpopKey()) ?? generateDpopKey()

  let loop: { server: Server; redirectUri: string }
  try {
    loop = await startLoopback((q, res) => void handleCallback(q, res))
  } catch {
    return { ok: false, reason: 'Could not open a local port to receive the sign-in.' }
  }

  const settled = new Promise<AccountStatus>((resolve) => {
    const timer = setTimeout(() => {
      endFlow()
      resolve(accountStatus())
    }, 5 * 60_000)
    pending = { state, verifier: pkce.verifier, redirectUri: loop.redirectUri, server: loop.server, timer, settle: resolve }
  })
  // Stash the freshly-minted (not-yet-persisted) key on the flow so the callback can
  // persist it only on success.
  flowKey = key

  const authorizeUrl = buildAuthorizeUrl({
    metadata: config.metadata,
    clientId: config.clientId,
    redirectUri: loop.redirectUri,
    resource: config.resource,
    challenge: pkce.challenge,
    state,
    scopes: config.scopes
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

let flowKey: DpopKey | null = null
let lastSettled: Promise<AccountStatus> | null = null

async function handleCallback(q: URLSearchParams, res: ServerResponse): Promise<void> {
  if (!pending) {
    res.writeHead(400).end()
    return
  }
  const flow = pending
  if (q.get('state') !== flow.state) {
    res.writeHead(400, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Sign-in failed', 'The response did not match our request.'))
    return
  }
  const error = q.get('error')
  if (error) {
    res.writeHead(200, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Sign-in cancelled', 'You can close this tab.'))
    endFlow()
    pushStatus()
    flow.settle(accountStatus())
    return
  }
  const code = q.get('code')
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Sign-in failed', 'No authorization code was returned.'))
    endFlow()
    flow.settle(accountStatus())
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(CLOSE_PAGE('Signed in', 'You can close this tab and return to the app.'))
  const redirectUri = flow.redirectUri
  const verifier = flow.verifier
  endFlow()

  const key = flowKey ?? generateDpopKey()
  const exchanged = await dpopTokenRequest(
    { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, resource: config!.resource },
    key
  )
  if (!exchanged.ok) {
    flow.settle(accountStatus())
    return
  }
  if (!persistGrant(exchanged.tokens, key)) {
    clearSession()
    flow.settle(accountStatus())
    return
  }
  dpopKey = key
  access = { token: exchanged.tokens.accessToken, expiresAt: exchanged.tokens.expiresAt }
  pushStatus()
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
  const rt = vaultLoad(VAULT_REFRESH)
  const key = await currentDpopKey()
  if (!rt || !key) {
    // No key means an unusable grant (another machine, or a cleared vault) — drop to
    // anon cleanly rather than pretend.
    clearSession()
    pushStatus()
    return null
  }
  const next = await dpopTokenRequest({ grant_type: 'refresh_token', refresh_token: rt, resource: config!.resource }, key)
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
  // ROTATION: persist the NEW refresh token (many AS rotate on every use; dropping it
  // strands the grant at the next expiry). mergeRefreshedTokens keeps the old one only
  // when the AS returned none.
  const merged = mergeRefreshedTokens({ accessToken: access?.token ?? '', refreshToken: rt }, next.tokens)
  if (!persistGrant(merged, key)) {
    clearSession()
    pushStatus()
    return null
  }
  access = { token: next.tokens.accessToken, expiresAt: next.tokens.expiresAt }
  pushStatus()
  return next.tokens.accessToken
}

/** A DPoP proof for a RESOURCE-SERVER call (the entitlement fetch): binds the proof to
 *  the presented access token via its hash (RFC 9449 `ath`). The proof is a PUBLIC JWT —
 *  the private key never enters this process (hardware) or leaves this module
 *  (software fallback), so custody is unchanged. Null when no session key exists. */
export async function dpopProofForResource(htm: string, htu: string, accessToken: string): Promise<string | null> {
  const key = await currentDpopKey()
  if (!key) return null
  return key.createProof({ htm, htu, accessToken })
}

/** The RFC 7638 thumbprint of the key of record — the device identity entitlements
 *  attest to and verify against (step 06). A PUBLIC value, never a secret. Opens
 *  (creating on first use) the device key, so callers invoke it lazily, post-boot. */
export async function deviceBindingJkt(): Promise<string | null> {
  return (await currentDpopKey())?.jkt ?? null
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

export async function logout(): Promise<void> {
  if (pending) endFlow()
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
 *  the DEVICEKEY smoke's honesty probe. Null when no key exists yet. */
export async function dpopCustodyForSmoke(): Promise<DpopKeyCustody | null> {
  return (await currentDpopKey())?.custody ?? null
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
