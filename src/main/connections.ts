import { ipcMain, shell, type BrowserWindow } from 'electron'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  ConnectionsChannels,
  type Connection,
  type ConnectionAuthKind,
  type McpPreset,
  type McpServerEntry,
  type OAuthClientRecord
} from '@contracts'
import {
  buildAuthorizeUrl,
  canonicalResource,
  canRepairClientByReRegistering,
  commitLandedGrant,
  createPkce,
  createState,
  discoverAccount,
  discoverAuthServer,
  exchangeCode,
  mergeRefreshedTokens,
  pickScopes,
  probeConnection,
  probeWithSchemes,
  redirectDriftAdvice,
  refreshTokens,
  removeStoredServer,
  resolveClient,
  sanitizeUserClient,
  saveServer,
  userClientRecord,
  oauthQuirksFor,
  runVerificationProbe,
  verificationSpecFor,
  RefreshCoordinator,
  MCP_PRESETS,
  type AuthServerMetadata,
  type ClientStore,
  type GrantKv,
  type OAuthTokens
} from '@backend/features/integrations'
import { getEntitlements } from '@backend'
import { getSettingsStore } from './app-settings'
import { getCliRuntime } from './cli-runtime'
import { mgrStatus } from './mcp-manager'
import { vaultAvailable, vaultClearKey, vaultLoad, vaultStore } from './vault'

// The connection broker (ADR 0014). The app IS the OAuth client: it holds one
// grant per service and the CLIs reach the service through it. See the whole
// stance in contracts/integrations/connections.ts.
//
// Custody, stated once: token material rests ONLY as safeStorage ciphertext, and
// is decrypted at exactly one point — `accessTokenFor`, immediately before it is
// attached to an outbound request. There is no IPC channel that returns it, by
// construction (the 8/08 discipline), so no renderer bug can leak one. A machine
// with no OS keychain REFUSES to connect rather than hold a refresh token in
// plaintext: that is 0008.h, and holding OAuth grants makes it matter more, not less.

const KV_META = (id: string): string => `connections.meta.${id}`
const KV_INDEX = 'connections.index'
const VAULT_TOKENS = (id: string): string => `connections.tokens.${id}`
const VAULT_CLIENT = (authServer: string): string => `connections.client.${hostKey(authServer)}`
const hostKey = (s: string): string => s.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 64)

let winGetter: (() => BrowserWindow | null) | null = null

// ── What is connectable ─────────────────────────────────────────────────────
// A CONNECTION is to a remote service. A stdio preset (aws, azure, elevenlabs)
// runs as a local process on the user's own machine and rides their own
// credential chain — there is nothing for the app to hold, and pretending
// otherwise would put a dead "Connect" button on a card that needs none. Those
// stay on the classic server path below the fold; the grid says why.
export const connectableServices = (): McpPreset[] => MCP_PRESETS.filter((p) => p.transport === 'http')

export const authKindOf = (p: McpPreset): ConnectionAuthKind =>
  p.authKinds.includes('oauth') ? 'oauth' : p.authKinds.includes('token') ? 'key' : 'local'

/** A self-hosted preset (n8n, Make) ships a placeholder, not a URL. It is
 *  connectable — it just needs the user's instance first. */
export const needsBaseUrl = (p: McpPreset): boolean => /YOUR-/.test(p.urlOrCommand)

const presetFor = (id: string): McpPreset | undefined => connectableServices().find((p) => p.id === id)

// ── The store: secret-free metadata in the KV, token material in the vault ──

function index(): string[] {
  try {
    const raw = getSettingsStore()?.getSetting(KV_INDEX)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function readMeta(id: string): Connection | null {
  try {
    const raw = getSettingsStore()?.getSetting(KV_META(id))
    return raw ? (JSON.parse(raw) as Connection) : null
  } catch {
    return null
  }
}

function writeMeta(c: Connection): void {
  const store = getSettingsStore()
  if (!store) return
  store.setSetting(KV_META(c.id), JSON.stringify(c))
  store.setSetting(KV_INDEX, JSON.stringify([...new Set([...index(), c.id])]))
  push()
}

function dropMeta(id: string): void {
  const store = getSettingsStore()
  if (!store) return
  store.setSetting(KV_META(id), '')
  store.setSetting(KV_INDEX, JSON.stringify(index().filter((x) => x !== id)))
  push()
}

/** Every connectable service, with its live state — connected or not. The grid
 *  renders THIS, so a card exists for a service you have never touched. */
export function listConnections(): Connection[] {
  const fromCatalog = connectableServices().map((p): Connection => {
    const stored = readMeta(p.id)
    // The preset-derived fields are recomputed over a stored meta, not trusted from
    // it: they describe the CATALOG (which auth kinds exist, whether a key path is
    // offered), and the catalog can evolve after the meta was written.
    const computed = {
      label: p.label,
      hasKeyOption: authKindOf(p) === 'oauth' && p.authKinds.includes('token'),
      needsBaseUrl: needsBaseUrl(p)
    }
    if (stored) return { ...stored, ...computed }
    return {
      id: p.id,
      authKind: authKindOf(p),
      state: 'disconnected' as const,
      url: needsBaseUrl(p) ? undefined : p.urlOrCommand,
      ...computed
    }
  })
  // A stored connection whose preset LEFT the catalog still holds a credential. It
  // must keep a card — a vaulted token with no Disconnect button anywhere is a
  // custody failure, not a tidy grid.
  const known = new Set(fromCatalog.map((c) => c.id))
  const orphans = index()
    .filter((id) => !known.has(id))
    .map((id) => readMeta(id))
    .filter((m): m is Connection => !!m)
  return [...fromCatalog, ...orphans]
}

function push(): void {
  try {
    winGetter?.()?.webContents.send(ConnectionsChannels.changed, listConnections())
  } catch {
    /* window gone; the KV is the truth */
  }
}

const setState = (id: string, patch: Partial<Connection>): Connection | null => {
  const base = readMeta(id) ?? listConnections().find((c) => c.id === id)
  if (!base) return null
  const next = { ...base, ...patch }
  writeMeta(next)
  return next
}

// ── Token material (vault only) ─────────────────────────────────────────────

const loadTokens = (id: string): OAuthTokens | null => {
  const raw = vaultLoad(VAULT_TOKENS(id))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthTokens
  } catch {
    return null
  }
}

/** Persist the grant — and ONLY the grant.
 *
 *  `raw` (the provider's full token response) is stripped here, deliberately and at the
 *  single choke point. It exists to resolve a display name at connect time and for no
 *  other reason; a provider may put anything in that object, including credentials we
 *  never asked for, and keeping it would mean holding secrets we cannot even name. */
const storeTokens = (id: string, t: OAuthTokens): boolean => {
  const { raw: _discarded, ...grant } = t
  return vaultStore(VAULT_TOKENS(id), JSON.stringify(grant))
}

const loadClient = (authServer: string): OAuthClientRecord | null => {
  const raw = vaultLoad(VAULT_CLIENT(authServer))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthClientRecord
  } catch {
    return null
  }
}

// ── The loopback redirect (RFC 8252) ────────────────────────────────────────
// Consent runs in the user's OWN browser — their real session, the vendor's real
// screen. The app never sees a password and never renders a login form. The code
// comes home to 127.0.0.1 on an ephemeral port, over a server that exists only
// for the length of one flow.

interface PendingFlow {
  serviceId: string
  state: string
  verifier: string
  redirectUri: string
  resource: string
  /** What we ASKED for. A provider that echoes no `scope` back on the token response
   *  still granted these, and the card should be able to say what the grant can do. */
  scopes: string[]
  metadata: AuthServerMetadata
  client: OAuthClientRecord
  server: Server
  timer: NodeJS.Timeout
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

/** Abandon a pending consent — the user's Cancel, and the supersede path. Without
 *  this, a superseded or cancelled flow left its card saying "connecting…" forever
 *  (there was no timer left to demote it, and nothing else ever would). */
function abandonFlow(reason?: string): void {
  if (!pending) return
  const abandoned = pending.serviceId
  endFlow()
  setState(abandoned, { state: 'disconnected', lastError: reason })
}

/** Bind the loopback listener and hand back the redirect URI it actually got.
 *  RFC 8252 §7.3 requires an authorization server to accept ANY port on a
 *  loopback redirect, so an ephemeral port is both legal and the safe choice —
 *  a fixed port is one already-in-use away from an unfixable failure. */
function startLoopback(onCode: (q: URLSearchParams, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; redirectUri: string }> {
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

/** The vault, worn as the ClientStore interface — so resolveClient (and its gate)
 *  stay Electron-free while the real records rest as OS-keychain ciphertext. */
const clientStore: ClientStore = {
  load: (issuer) => loadClient(issuer),
  save: (issuer, record) => vaultStore(VAULT_CLIENT(issuer), JSON.stringify(record)),
  clear: (issuer) => vaultClearKey(VAULT_CLIENT(issuer))
}

/** A connection URL: https anywhere, or plain http strictly on loopback — a
 *  self-hosted n8n on this very machine is a real development setup, and the
 *  registry's route-B rule already allows exactly the same exception. */
const validConnectionUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
  } catch {
    return false
  }
}

/** The connections-count gate (phase-accounts/05): a NEW connection past the plan's
 *  cap refuses with a visible upgrade reason; reconnecting or repairing a service the
 *  user already holds is never blocked. Reads the Entitlements PORT — which tier gets
 *  what is the config table + the signed claim, never a number here. Local UX only
 *  (ADR 0016 §5), and the Free row is generous. */
export function connectionQuotaRefusal(serviceId: string): string | null {
  const held = index()
  if (held.includes(serviceId)) return null
  const cap = getEntitlements().limit('maxConnections')
  if (held.length < cap) return null
  const plan = getEntitlements().snapshot().plan
  return `Your ${plan} plan connects up to ${cap} ${cap === 1 ? 'service' : 'services'}, all in use. Disconnect one, or upgrade your MoggingLabs plan for more.`
}

/**
 * Start an OAuth flow. Resolves when the browser has been OPENED — not when the
 * user finishes. The card goes to `connecting` and the real answer arrives later
 * over the `changed` push, because a human at a consent screen is not something
 * an IPC call may block on.
 */
export async function connect(serviceId: string, baseUrl?: string): Promise<{ ok: boolean; reason?: string }> {
  const preset = presetFor(serviceId)
  if (!preset) return { ok: false, reason: 'unknown service' }
  const quota = connectionQuotaRefusal(serviceId)
  if (quota) return { ok: false, reason: quota }
  const kind = authKindOf(preset)
  if (kind === 'key') return { ok: false, reason: 'This one takes an API key — paste it on the card.' }
  // The keychain gate applies to OAUTH only: it exists to refuse holding a refresh
  // token in plaintext. A no-account (`local`) connection stores nothing, and gating
  // it left cloudflare-docs unconnectable on a keychain-less machine for no reason.
  if (kind === 'oauth' && !vaultAvailable()) {
    return {
      ok: false,
      reason: 'This machine has no OS keychain, so we will not hold a refresh token for you. Use the per-CLI path below instead.'
    }
  }
  const url = needsBaseUrl(preset) ? String(baseUrl ?? '').trim() : preset.urlOrCommand
  if (!url) return { ok: false, reason: `${preset.label} is self-hosted — paste your instance's MCP URL first.` }
  if (!validConnectionUrl(url)) return { ok: false, reason: 'A connection must be an https:// URL (plain http only for localhost).' }

  // One flow at a time — and the superseded service's card must not stay
  // "connecting…" forever, which is exactly what plain endFlow() left behind.
  abandonFlow()
  // A user-initiated reconnect always may try — the refresh cooldown protects
  // the token endpoint from OUR retry loops, never from the user's own click.
  resetRefreshCooldown(serviceId)
  // `needsClientId` is re-derived by THIS attempt, not carried over: a stale flag
  // from a previous failure must not leave the paste form on a card whose current
  // failure (an outage, a bad URL) pasting a client id cannot fix.
  setState(serviceId, { state: 'connecting', url, lastError: undefined, needsClientId: undefined })

  // `requireAuth` for oauth presets: Google's servers answer initialize (and even
  // tools/list) with NO credential and only gate at tool-call time. Taking the
  // no-auth shortcut there would mint a green "connected" card whose every real
  // call fails. An oauth preset must come back with a grant or an honest error.
  const disco = await discoverAuthServer(url, { requireAuth: kind === 'oauth' })
  if (!disco.ok) {
    // "No auth needed" is a SUCCESS wearing a failure's clothes: the server is
    // usable right now. Record it as such instead of showing the user an error.
    if (disco.noAuthNeeded) {
      const probe = await probeConnection(url)
      setState(serviceId, {
        state: probe.ok ? 'connected' : 'error',
        url,
        connectedAt: Date.now(),
        serverName: probe.ok ? probe.probe.serverName : undefined,
        toolCount: probe.ok ? probe.probe.toolCount : undefined,
        tools: probe.ok ? probe.probe.tools : undefined,
        lastError: probe.ok ? undefined : probe.reason
      })
      if (probe.ok) registerConnectionServer(serviceId)
      return { ok: probe.ok, reason: probe.ok ? undefined : probe.reason }
    }
    setState(serviceId, { state: 'error', lastError: disco.reason })
    return { ok: false, reason: disco.reason }
  }

  // The RESOURCE's scopes, not the authorization server's. gitlab.com's AS supports
  // `api`, `create_runner`, `manage_runner`, `k8s_proxy`; its MCP resource asks for
  // exactly one scope, `mcp`. Asking the AS for everything it offers would have put a
  // consent screen in front of the user requesting to manage their Kubernetes cluster
  // in order to read an issue. pickScopes adds identity scopes and nothing else.
  const { metadata, resource } = disco
  const scopes = pickScopes(disco.resourceScopes, metadata)
  let loop: { server: Server; redirectUri: string }
  try {
    loop = await startLoopback((params, res) => void onCallback(params, res))
  } catch {
    setState(serviceId, { state: 'error', lastError: 'Could not open a local port to receive the sign-in.' })
    return { ok: false, reason: 'Could not open a local port to receive the sign-in.' }
  }

  const client = await resolveClient(metadata, loop.redirectUri, clientStore)
  if (!client.ok) {
    try {
      loop.server.close()
    } catch {
      /* never listened */
    }
    // `needsClientId` turns this dead end into a form: the card offers the paste
    // fields instead of a Reconnect that could only fail identically. `authServer`
    // rides along so the form can name WHOSE console the client must come from.
    setState(serviceId, { state: 'error', lastError: client.reason, needsClientId: client.needsClientId, authServer: metadata.issuer })
    return { ok: false, reason: client.reason }
  }

  const pkce = createPkce()
  const state = createState()
  pending = {
    serviceId,
    state,
    verifier: pkce.verifier,
    redirectUri: loop.redirectUri,
    resource,
    scopes,
    metadata,
    client: client.client,
    server: loop.server,
    // A consent screen a user walked away from must not strand the card on
    // "connecting" forever, and must not leave a port open all session.
    timer: setTimeout(() => {
      setState(serviceId, { state: 'error', lastError: 'Sign-in was not completed in 5 minutes. Try again.' })
      endFlow()
    }, 5 * 60_000)
  }

  await shell.openExternal(
    buildAuthorizeUrl({
      metadata,
      clientId: client.client.clientId,
      redirectUri: loop.redirectUri,
      resource,
      challenge: pkce.challenge,
      state,
      scopes
    })
  )
  return { ok: true }
}

async function onCallback(params: URLSearchParams, res: import('node:http').ServerResponse): Promise<void> {
  const flow = pending
  const html = (title: string, body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CLOSE_PAGE(title, body))
  }
  if (!flow) {
    html('Nothing to finish', 'This sign-in is no longer in progress. You can close this tab.')
    return
  }
  // A mismatched `state` is the CSRF check, and it fails closed: an attacker who
  // can reach the loopback port must not be able to graft their own code onto our
  // flow. Never trust a callback we did not start.
  if (params.get('state') !== flow.state) {
    html('That sign-in did not match', 'The response did not match the request we sent. Nothing was connected.')
    setState(flow.serviceId, { state: 'error', lastError: 'The provider’s response did not match our request.' })
    endFlow()
    return
  }
  const denied = params.get('error')
  if (denied) {
    const desc = params.get('error_description') ?? denied
    html('Sign-in cancelled', 'Nothing was connected. You can close this tab.')
    setState(flow.serviceId, { state: 'disconnected', lastError: desc.slice(0, 160) })
    endFlow()
    return
  }
  const code = params.get('code')
  if (!code) {
    html('Sign-in incomplete', 'The provider sent no authorization code. You can close this tab.')
    setState(flow.serviceId, { state: 'error', lastError: 'The provider sent no authorization code.' })
    endFlow()
    return
  }

  const exchanged = await exchangeCode(flow.metadata, flow.client, {
    code,
    verifier: flow.verifier,
    redirectUri: flow.redirectUri,
    resource: flow.resource,
    // Catalog method quirks ride into the normalization seam, exchange included.
    quirks: oauthQuirksFor(flow.serviceId)
  })
  // The exchange is the ONE await a cancel can interleave: the user's Cancel (or a
  // superseding connect, or clearClient) ran abandonFlow while the token trip was in
  // flight. From here the flow is not ours to finish — storing the tokens would re-mint
  // a "connected" card over an explicit cancel, and endFlow() would tear down whatever
  // NEWER flow now owns `pending`. Discard, answer the tab honestly, and touch nothing.
  // (A cancel that lands AFTER storeTokens is the other order: the grant completed
  // first, and a landed grant stands — the same stance clearClient documents.)
  if (pending !== flow) {
    html('Sign-in cancelled', 'This sign-in was cancelled in the app before it finished. Nothing was connected.')
    return
  }
  if (!exchanged.ok) {
    // redirect_uri drift: the cached client was registered against a PREVIOUS flow's
    // loopback port. RFC 8252 §7.3 obliges the AS to accept any loopback port, but an
    // AS that doesn't refuses right here — and reusing the same cached client would
    // fail identically forever. Purging it makes the next attempt re-register with
    // the current URI, so "try again" is real advice rather than a loop. A USER-pasted
    // client is never purged — we cannot re-register to replace it, and eating the
    // user's own credentials is worse than the failure; the advice changes instead
    // (fix the client's redirect settings at the vendor).
    const redirectDrift = /redirect[_ ]?uri|redirect mismatch/i.test(exchanged.reason)
    if (redirectDrift && canRepairClientByReRegistering(flow.client)) vaultClearKey(VAULT_CLIENT(flow.metadata.issuer))
    html('Sign-in failed', 'We could not complete the exchange. Check the app for the reason.')
    setState(flow.serviceId, {
      state: 'error',
      lastError: redirectDrift ? redirectDriftAdvice(flow.client, exchanged.reason) : exchanged.reason
    })
    endFlow()
    return
  }
  if (!storeTokens(flow.serviceId, exchanged.tokens)) {
    html('Sign-in failed', 'The OS keychain would not hold the credential, so nothing was saved.')
    setState(flow.serviceId, { state: 'error', lastError: 'The OS keychain would not hold the credential — nothing was saved.' })
    endFlow()
    return
  }

  // The grant is stored, so the connection is CONNECTED now — proven by the grant, not
  // by the follow-up probe. commitLandedGrant runs the two-phase sequence: commit +
  // register + answer the tab + close the flow synchronously (so a Cancel landing after
  // is a no-op on a live connection), then enrich best-effort under the stamp guard. The
  // sequence lives in the Electron-free orchestrator precisely so CONNPURE can bite it.
  const tokens = exchanged.tokens
  await commitLandedGrant(
    {
      setState: (patch) => void setState(flow.serviceId, patch),
      readState: () => readMeta(flow.serviceId),
      registerServer: () => void registerConnectionServer(flow.serviceId),
      closeFlow: endFlow,
      showPage: html,
      discoverAccount: () => discoverAccount(tokens, flow.metadata),
      probe: () => probeConnection(flow.resource, tokens.accessToken),
      now: Date.now
    },
    {
      label: presetFor(flow.serviceId)?.label ?? flow.serviceId,
      scopes: tokens.scopes ?? flow.scopes,
      expiresAt: tokens.expiresAt,
      // The grant landed, so whatever client made it is proven: remember WHERE this
      // service signs in and whether the client was the user's own — that pair is what
      // lets "Forget client ID" find the record later, even after a disconnect.
      authServer: flow.metadata.issuer,
      userClient: flow.client.source === 'user'
    }
  )
}

// ── API-key connections: the same card, the same proof ──────────────────────

/**
 * Connect with a pasted key. NO setState until the outcome is known — this is
 * deliberate, and it fixes a bug that ate keys: an intermediate "connecting" state
 * pushed a grid repaint, the repaint rebuilt the input element, and the key the user
 * had pasted vanished mid-verification. On failure the same repaint defeated the
 * retain-on-failure promise. The button's own busy label carries the progress; the
 * grid repaints exactly once, on success, when there is something true to show.
 */
export async function submitKey(serviceId: string, value: string, baseUrl?: string): Promise<{ ok: boolean; reason?: string }> {
  const preset = presetFor(serviceId)
  if (!preset) return { ok: false, reason: 'unknown service' }
  const quota = connectionQuotaRefusal(serviceId)
  if (quota) return { ok: false, reason: quota } // before the key is even read — a refused paste stays in the field
  if (!value.trim()) return { ok: false, reason: 'Paste the key first.' }
  if (!vaultAvailable()) {
    return { ok: false, reason: 'This machine has no OS keychain, so the key cannot be stored safely here.' }
  }
  // Self-hosted (n8n, Make): the instance URL arrives WITH the key. Before this
  // parameter existed, the card's key form had no URL field and this branch refused
  // with "paste your instance's MCP URL first" — an instruction with nowhere to obey it.
  const url = needsBaseUrl(preset) ? String(baseUrl ?? '').trim() : preset.urlOrCommand
  if (!url) return { ok: false, reason: `${preset.label} is self-hosted — paste your instance's MCP URL above the key.` }
  if (!validConnectionUrl(url)) return { ok: false, reason: 'The instance URL must be https:// (plain http only for localhost).' }
  resetRefreshCooldown(serviceId)
  // PROVE-BEFORE-SAVE, catalog-first (phase-tools/02): a service that declares a
  // verification endpoint gets the provider's own 401 in one cheap REST trip —
  // before the MCP handshake, and before anything could save. The catalog probe
  // REFUSES only on the provider's own unauthorized answer; an unreachable or
  // erroring verification endpoint proves nothing about the key and falls
  // through to the MCP proof below, which remains the final word either way.
  const verificationSpec = verificationSpecFor(serviceId)
  if (verificationSpec) {
    const proof = await runVerificationProbe(verificationSpec, value.trim())
    if (!proof.ok && proof.unauthorized) {
      return { ok: false, reason: 'That key was refused by the service.' }
    }
  }
  // VERIFY BEFORE WE CLAIM — and discover which Authorization scheme the server
  // takes while we're at it (Bearer for almost everyone; `Key` for fal.ai).
  const probe = await probeWithSchemes(url, value.trim())
  if (!probe.ok) {
    return { ok: false, reason: probe.unauthorized ? 'That key was refused by the service.' : probe.reason }
  }
  if (!storeTokens(serviceId, { accessToken: value.trim() })) {
    return { ok: false, reason: 'The OS keychain would not hold the key.' }
  }
  setState(serviceId, {
    state: 'connected',
    url,
    connectedAt: Date.now(),
    serverName: probe.probe.serverName,
    toolCount: probe.probe.toolCount,
    tools: probe.probe.tools,
    expiresAt: undefined,
    authScheme: probe.authScheme,
    // A dual-auth card (GitHub) may carry needsClientId from a FAILED OAuth attempt.
    // The key connected it: the stale flag must not resurface as "Add client ID…"
    // being the primary verb when this key later expires.
    needsClientId: undefined,
    // A key names an account too — the server will say whose, if it offers a whoami tool.
    // "Connected as pedro@…" matters just as much when the credential was pasted.
    account: probe.probe.account,
    lastError: undefined
  })
  registerConnectionServer(serviceId)
  return { ok: true }
}

// ── Pre-registered OAuth clients: the no-DCR on-ramp (Google, GitHub, Slack) ─

/**
 * Store a client the USER registered in the provider's own console, then go
 * straight into consent. Pasting the id is step one of connecting, not its own
 * ceremony — a saved-but-unused client would leave the card exactly as broken
 * as before, one click later.
 *
 * The record is keyed by ISSUER, so one pasted Google client covers Drive,
 * Gmail, Calendar and Chat alike: they all sign in at accounts.google.com —
 * and the flag flip fans out to every sibling card at the same issuer, so a
 * card that failed BEFORE the paste gets its Connect verb back without a
 * second paste. Nothing is pushed before the record is safely stored (every
 * earlier refusal returns without a repaint, so the form keeps its fields);
 * once connect() takes over, its pushes repaint the grid and the form's own
 * failure surface is the toast, not a node the repaint may have detached.
 */
export async function submitClient(
  serviceId: string,
  clientId: string,
  clientSecret?: string,
  baseUrl?: string
): Promise<{ ok: boolean; reason?: string }> {
  const preset = presetFor(serviceId)
  if (!preset) return { ok: false, reason: 'unknown service' }
  if (authKindOf(preset) !== 'oauth') {
    return { ok: false, reason: 'This service does not sign in with OAuth — there is no client to register.' }
  }
  const cleaned = sanitizeUserClient(clientId, clientSecret)
  if (!cleaned.ok) return cleaned
  if (!vaultAvailable()) {
    return { ok: false, reason: 'This machine has no OS keychain, so the client credentials cannot be stored safely here.' }
  }
  const url = needsBaseUrl(preset) ? String(baseUrl ?? '').trim() : preset.urlOrCommand
  if (!url) return { ok: false, reason: `${preset.label} is self-hosted — paste your instance's MCP URL first.` }
  if (!validConnectionUrl(url)) return { ok: false, reason: 'A connection must be an https:// URL (plain http only for localhost).' }
  // The record must key on the REAL issuer, so the client the user pasted on the
  // Drive card is found again from the Gmail card — and from this card next year.
  const metadata = await fetchAuthServerMetadataFor(url)
  if (!metadata) {
    return { ok: false, reason: 'Could not reach the provider to find its sign-in server, so nothing was saved. Try again.' }
  }
  const record = userClientRecord(metadata.issuer, cleaned.clientId, cleaned.clientSecret)
  if (!clientStore.save(metadata.issuer, record)) {
    return { ok: false, reason: 'The OS keychain would not hold the client credentials — nothing was saved.' }
  }
  setState(serviceId, { needsClientId: undefined, userClient: true, authServer: metadata.issuer, lastError: undefined })
  // The record serves EVERY card at this issuer. A sibling that already failed with
  // "needs a client id" must get its Connect verb back now — without this sweep the
  // user re-pastes the same client on every previously-failed Google card.
  for (const c of listConnections()) {
    if (c.id === serviceId || c.authServer !== metadata.issuer) continue
    const wasClientFailure = c.needsClientId === true
    setState(c.id, {
      needsClientId: undefined,
      userClient: true,
      ...(wasClientFailure && c.state === 'error' ? { state: 'disconnected' as const, lastError: undefined } : {})
    })
  }
  const opened = await connect(serviceId, baseUrl)
  if (opened.ok) return opened
  // The paste itself SUCCEEDED — a connect failure after it must not read as "the
  // client was refused", or the user re-pastes forever at a network blip.
  return { ok: false, reason: `The client ID was saved. Connecting then failed: ${opened.reason}` }
}

/**
 * Forget a pasted client — the id and its vaulted secret. Scoped to the ISSUER,
 * so it is announced on every card that signs in there: forgetting Google's
 * client on the Drive card also stops Gmail's next refresh from using it, and
 * each affected card says so instead of silently going stale.
 */
export function clearClient(serviceId: string): { ok: boolean; reason?: string } {
  const meta = readMeta(serviceId)
  const issuer = meta?.authServer
  if (!issuer || !meta?.userClient) return { ok: false, reason: 'No pasted client is stored for this service.' }
  // A consent mid-flight at this issuer still holds the client IN MEMORY: left alone,
  // the browser callback would land after the record is gone and stamp a connected
  // card claiming a pasted client the vault no longer holds. Abandon it first.
  if (pending && pending.metadata.issuer === issuer) {
    abandonFlow('The client ID was forgotten while this sign-in was open. Start again once a client ID is saved.')
  }
  clientStore.clear(issuer)
  for (const c of listConnections()) {
    if (c.authServer !== issuer || !c.userClient) continue
    if (c.state === 'connected') {
      // The GRANT is untouched; only the handle changes. When the token eventually
      // expires, doRefresh names the real fix (paste a client ID) — an invisible
      // warning written here would land on a field no connected card renders.
      setState(c.id, { userClient: undefined })
    } else if (c.state === 'disconnected') {
      // A disconnected meta existed ONLY as the handle on this record (no token —
      // disconnect and denied-consent both leave none). Releasing it returns the
      // card to pristine catalog defaults instead of an immortal husk whose only
      // verb is a paste form.
      dropMeta(c.id)
    } else {
      setState(c.id, { userClient: undefined, needsClientId: true })
    }
  }
  return { ok: true }
}

/** The user's Cancel while a browser consent is pending — and the manual unstick for
 *  a card that says "connecting" with no live flow behind it (however it got there). */
export function cancelConnect(serviceId: string): void {
  if (pending?.serviceId === serviceId) {
    abandonFlow()
    return
  }
  const meta = readMeta(serviceId)
  if (meta?.state === 'connecting') setState(serviceId, { state: 'disconnected', lastError: undefined })
}

// ── Refresh + the one decryption point ──────────────────────────────────────

/** The refresh discipline (phase-tools/02, credential-core): per-connection lock,
 *  freshness margin, failure cooldown, re-check-after-lock. ONE holder is the
 *  whole reason app-held OAuth is sound under refresh-token rotation (ADR 0014) —
 *  and the coordinator is what makes "one holder" true under concurrent demand
 *  (proxy call + heartbeat + manual Check racing the same rotation). */
const refreshCoordinator = new RefreshCoordinator()

/**
 * The access token for an outbound call — the ONLY place token material is
 * decrypted, and it never leaves this module. Refreshes with a margin of slack so
 * a call in flight cannot expire mid-request; a provider that refused a refresh
 * is not re-asked until the cooldown passes (the card already says `expired`).
 */
export async function accessTokenFor(serviceId: string): Promise<string | null> {
  const tokens = loadTokens(serviceId)
  if (!tokens) return null
  if (tokens.expiresAt && tokens.expiresAt - Date.now() <= 60_000 && !tokens.refreshToken) {
    setState(serviceId, { state: 'expired', lastError: 'The connection expired and cannot renew itself.' })
    return null
  }
  const out = await refreshCoordinator.current<OAuthTokens>(serviceId, {
    load: () => loadTokens(serviceId),
    refresh: (current) => doRefresh(serviceId, current),
    store: (next) => {
      if (!storeTokens(serviceId, next)) return false
      setState(serviceId, { state: 'connected', expiresAt: next.expiresAt, scopes: next.scopes, lastError: undefined })
      return true
    }
  })
  if (out.ok) return out.credential.accessToken
  // A cooled refusal repeats no state churn — the refusal that STARTED the
  // cooldown already set `expired` with the provider's own sentence.
  if (!out.cooled && out.reason === 'the OS keychain would not hold the renewed credential') {
    setState(serviceId, { state: 'error', lastError: 'The OS keychain would not hold the renewed credential.' })
  }
  return null
}

/** A user-initiated reconnect always may try: connect() and submitKey() clear the
 *  refresh cooldown so "the app refused to even try" can never be the story. */
const resetRefreshCooldown = (serviceId: string): void => refreshCoordinator.reset(serviceId)

/** One refresh trip: discovery + client + token call + rotation merge. State
 *  transitions for FAILURES live here (they carry provider-specific advice);
 *  the success write lives in the coordinator's `store` above. */
async function doRefresh(
  serviceId: string,
  tokens: OAuthTokens
): Promise<{ ok: true; credential: OAuthTokens } | { ok: false; reason: string }> {
  const meta = readMeta(serviceId)
  const url = meta?.url
  if (!url) return { ok: false, reason: 'no connection url' }
  if (!tokens.refreshToken) {
    setState(serviceId, { state: 'expired', lastError: 'The connection expired and cannot renew itself.' })
    return { ok: false, reason: 'no refresh token' }
  }
  const disco = await fetchAuthServerMetadataFor(url)
  if (!disco) {
    setState(serviceId, { state: 'error', lastError: 'Could not reach the provider to renew the connection.' })
    return { ok: false, reason: 'discovery failed' }
  }
  const client = loadClient(disco.issuer)
  if (!client) {
    // Match the advice to what clicking it will DO. At a DCR issuer, Reconnect
    // re-registers and works; at a no-DCR issuer (exactly where a forgotten pasted
    // client lands us), Reconnect can only fail into the same wall — say "paste a
    // client ID" and set the flag so the card offers the form directly.
    const noDcr = !disco.registration_endpoint
    setState(serviceId, {
      state: 'expired',
      needsClientId: noDcr ? true : undefined,
      authServer: disco.issuer,
      lastError: noDcr
        ? 'The client registration is gone — paste a client ID to reconnect.'
        : 'The client registration is gone — reconnect to renew it.'
    })
    return { ok: false, reason: 'client registration gone' }
  }
  const next = await refreshTokens(disco, client, {
    refreshToken: tokens.refreshToken,
    resource: canonicalResource(url),
    // Catalog method quirks ride into the normalization seam — the one place
    // `tokenExpirationBuffer` and friends are ever applied.
    quirks: oauthQuirksFor(serviceId)
  })
  if (!next.ok) {
    // The cached AS metadata may be the reason (a provider that moved its token
    // endpoint would fail here forever — the cache has no TTL). Drop it so the next
    // attempt re-discovers instead of retrying into the same stale endpoint.
    metaCache.delete(url)
    setState(serviceId, { state: 'expired', lastError: `The connection could not renew: ${next.reason}` })
    return { ok: false, reason: next.reason }
  }
  // ROTATION: many providers issue a NEW refresh token on every use and invalidate
  // the old one; others return none on refresh at all. Both hands of that rule live
  // in mergeRefreshedTokens (pure — the regression suite bites on it directly).
  return { ok: true, credential: mergeRefreshedTokens(tokens, next.tokens) }
}

/** Cached AS metadata per connection URL — discovery is three round trips we do
 *  not want on every token refresh. */
const metaCache = new Map<string, AuthServerMetadata>()
async function fetchAuthServerMetadataFor(url: string): Promise<AuthServerMetadata | null> {
  const hit = metaCache.get(url)
  if (hit) return hit
  // requireAuth always: only OAuth connections ever refresh, and a Google-style
  // server that 200s an unauthenticated initialize must not shortcut discovery
  // here either — the refresh needs the real AS metadata or it needs to fail.
  const disco = await discoverAuthServer(url, { requireAuth: true })
  if (!disco.ok) return null
  metaCache.set(url, disco.metadata)
  return disco.metadata
}

/** What the proxy needs: where to send the call, and what to send it with. */
export async function connectionUpstream(
  serviceId: string
): Promise<{ url: string; token?: string; authScheme?: string } | null> {
  const meta = readMeta(serviceId)
  if (!meta?.url || meta.state === 'disconnected') return null
  const token = await accessTokenFor(serviceId)
  // A `local` (no-auth) connection legitimately has no token — that is not a failure.
  if (!token && meta.authKind !== 'local') return null
  return { url: meta.url, token: token ?? undefined, authScheme: meta.authScheme }
}

// ── The connection as a server the CLIs can be given ────────────────────────

/**
 * Register the connection as an MCP server whose command is OUR BRIDGE.
 *
 * This is the join between the new world and the existing one, and the reason the
 * whole change fits: the tool plan, the per-CLI writers, the drift detector and
 * the backups all keep working, unchanged — they simply fan out an entry that
 * holds no secret. What lands in `~/.claude.json` is a command and a service id.
 * The token stays here, on the far side of a token-authed local socket.
 */
export function registerConnectionServer(serviceId: string): { ok: boolean; reason?: string } {
  const store = getSettingsStore()
  const preset = presetFor(serviceId)
  if (!store || !preset) return { ok: false, reason: 'store not ready' }
  const runtime = getCliRuntime()
  const kv: GrantKv = { get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }
  // NO `env`. The shim sets ELECTRON_RUN_AS_NODE itself, because the entry validator
  // refuses any env value that is not a `${VAR}` reference — see CliRuntime.connectionShim.
  // What lands in the CLI's config is a command and a service id, and nothing else.
  const entry: McpServerEntry = {
    id: serviceId,
    label: preset.label,
    transport: 'stdio',
    command: runtime.connectionShim,
    args: ['--connection', serviceId]
  }
  const saved = saveServer(kv, entry)
  if (!saved.ok) {
    // NEVER silent. A refusal here means the connection is live but no CLI can reach
    // it — a card reading "connected" over a service no agent can call. Say it on the
    // card rather than leave the user to discover it from an agent's confusion.
    setState(serviceId, { lastError: `Connected, but the CLI entry was refused: ${saved.reason}` })
  }
  return saved
}

export function disconnect(serviceId: string): void {
  const meta = readMeta(serviceId)
  // The vault slot first: if anything below throws, the credential is already gone.
  vaultClearKey(VAULT_TOKENS(serviceId))
  metaCache.delete(meta?.url ?? '')
  if (meta?.userClient && meta.authServer) {
    // The GRANT is gone; the pasted client stays (reconnecting is one click, not a
    // trip back to the vendor's console). But a vaulted secret with no pixel that
    // can delete it is a custody failure — so the card keeps its handle on the
    // record (`userClient` + `authServer`) instead of dropping the whole meta,
    // and "Forget client ID" keeps working after a disconnect.
    writeMeta({
      id: meta.id,
      label: meta.label,
      authKind: meta.authKind,
      state: 'disconnected',
      userClient: true,
      authServer: meta.authServer
    })
  } else {
    dropMeta(serviceId)
  }
  // The bridge server row this connection registered: remove it when no CLI has it
  // applied, so a disconnect doesn't leave a ghost in "Servers & registry" and the
  // tool-plan matrix forever. If it IS applied somewhere, it stays — the CLI's config
  // still names our bridge, and yanking the registry row under an applied entry would
  // strand it as unremovable drift. The bridge itself answers "not connected" either
  // way; the disconnect toast already tells the user what we did and did not do.
  try {
    const store = getSettingsStore()
    if (store && !mgrStatus(serviceId).some((s) => s.state === 'applied' || s.state === 'drift-edited')) {
      removeStoredServer({ get: (k) => store.getSetting(k), set: (k, v) => store.setSetting(k, v) }, serviceId)
    }
  } catch {
    /* registry cleanup is best-effort; the credential above is already gone */
  }
  // We do NOT revoke at the vendor. We cannot promise it (many have no revoke
  // endpoint), and a promise we cannot keep is worse than the sentence the card
  // shows instead: sign out at the provider to kill the grant everywhere.
}

/** Prove it, now. The card's "Check" verb, and what runs when Settings opens. */
export async function verify(serviceId: string): Promise<Connection | null> {
  const meta = readMeta(serviceId)
  if (!meta?.url) return listConnections().find((c) => c.id === serviceId) ?? null
  const token = await accessTokenFor(serviceId)
  if (!token && meta.authKind !== 'local') {
    return setState(serviceId, { state: 'expired', lastError: 'The connection could not be renewed — reconnect it.' })
  }
  const probe = await probeConnection(meta.url, token ?? undefined, { authScheme: meta.authScheme })
  if (!probe.ok) {
    return setState(serviceId, {
      state: probe.unauthorized ? 'expired' : 'error',
      lastError: probe.unauthorized ? 'The service no longer accepts this connection — reconnect it.' : probe.reason
    })
  }
  return setState(serviceId, {
    state: 'connected',
    serverName: probe.probe.serverName,
    toolCount: probe.probe.toolCount,
    tools: probe.probe.tools,
    // Re-checking can FILL IN a name we could not get at connect time (a server that was
    // slow, or a whoami tool the vendor added since). Never blank one we already have.
    account: probe.probe.account ?? meta.account,
    lastError: undefined
  })
}

/** A stored `connecting` state at BOOT is a lie: the flow it described died with the
 *  previous process (loopback port, PKCE verifier, timer — all gone). Left alone it
 *  rendered a card that said "connecting…" forever, surviving restarts, with nothing
 *  behind it that could ever finish. Demote to an explained error. */
export function sweepInterruptedFlows(): void {
  for (const id of index()) {
    const meta = readMeta(id)
    if (meta?.state === 'connecting') {
      setState(id, { state: 'error', lastError: 'The sign-in was interrupted (the app closed mid-flow). Try again.' })
    }
  }
}

export function registerConnections(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  sweepInterruptedFlows()
  ipcMain.handle(ConnectionsChannels.list, () => listConnections())
  ipcMain.handle(ConnectionsChannels.connect, (_e, p: string | { serviceId: string; baseUrl?: string }) => {
    const serviceId = typeof p === 'string' ? p : String(p?.serviceId ?? '')
    const baseUrl = typeof p === 'string' ? undefined : p?.baseUrl
    return connect(serviceId, baseUrl ? String(baseUrl) : undefined)
  })
  ipcMain.handle(ConnectionsChannels.submitKey, (_e, p: { serviceId: string; value: string; baseUrl?: string }) =>
    submitKey(String(p?.serviceId ?? ''), String(p?.value ?? ''), p?.baseUrl ? String(p.baseUrl) : undefined)
  )
  // Write-only, like submitKey: the secret goes IN over this channel and no channel
  // brings a client secret back out (the 8/08 discipline).
  ipcMain.handle(
    ConnectionsChannels.setClient,
    (_e, p: { serviceId: string; clientId: string; clientSecret?: string; baseUrl?: string }) =>
      submitClient(
        String(p?.serviceId ?? ''),
        String(p?.clientId ?? ''),
        p?.clientSecret ? String(p.clientSecret) : undefined,
        p?.baseUrl ? String(p.baseUrl) : undefined
      )
  )
  ipcMain.handle(ConnectionsChannels.clearClient, (_e, id: string) => clearClient(String(id)))
  ipcMain.handle(ConnectionsChannels.cancel, (_e, id: string) => cancelConnect(String(id)))
  ipcMain.handle(ConnectionsChannels.disconnect, (_e, id: string) => disconnect(String(id)))
  ipcMain.handle(ConnectionsChannels.verify, (_e, id: string) => verify(String(id)))
}
