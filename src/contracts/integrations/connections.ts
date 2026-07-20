// The CONNECTION (ADR 0014, superseding ADR 0008.d's deferral).
//
// A connection is an app-owned, authenticated link to a service ACCOUNT — and it
// is deliberately NOT a CLI config entry. The app is the OAuth client: it holds
// ONE grant per service as OS-vault ciphertext, and the CLIs reach the service
// THROUGH the app (bin/mogging-connection.mjs -> the token-authed local endpoint
// that already carries the house server). So:
//
//   · no token ever lands in a CLI config, a CLI's credential store, or on disk
//     in plaintext — a CLI's config entry for a connection is a COMMAND, nothing
//     more, and carries no secret at all;
//   · one grant means ONE refresher. 0008.d called a shared app-held grant
//     "technically unsound" under OAuth 2.1 refresh-token rotation, and it is —
//     if you hand the token to N CLIs, which then race to refresh and invalidate
//     each other. Holding it once and proxying is the sound shape, and the whole
//     reason this ADR could be written;
//   · "connected" stops being a guess. The app holds the grant, so it can PROVE
//     the connection by calling the server (initialize + tools/list) instead of
//     regex-scraping `claude mcp list` every fifteen minutes.
//
// Nothing here is a secret: this is the shape the RENDERER sees. Token material
// never leaves main — there is no channel that can carry it (the 8/08 discipline).

/** How a connection authenticates.
 *  · `oauth` — the app runs OAuth 2.1 + PKCE and holds the grant.
 *  · `key`   — the user pastes an API key once; it rests as vault ciphertext.
 *  · `local` — a REMOTE server that needs no account at all (docs servers and the
 *              like): Connect just verifies it and hands it to your agents. (stdio
 *              presets riding your machine's own credential chain never reach this
 *              grid — they are filtered out at the source.) */
export type ConnectionAuthKind = 'oauth' | 'key' | 'local'

/** What the card shows. Every state below `connected` is a state the app can
 *  SEE — none of them is inferred from a config file's contents. */
export type ConnectionState =
  | 'disconnected' // never connected, or the user revoked it
  | 'connecting' // consent is open in the browser, or a key is being verified
  | 'connected' // verified: the server answered initialize + tools/list
  | 'expired' // the grant no longer refreshes — the user must reconnect
  | 'error' // the last attempt failed; `lastError` says why, in their words

/** The renderer's view of one connection. Secret-free by construction. */
export interface Connection {
  /** The service id — the preset it was made from (e.g. `sentry`). */
  id: string
  label: string
  authKind: ConnectionAuthKind
  state: ConnectionState
  /** The remote MCP endpoint this connection speaks to. */
  url?: string

  // ── Proof, not inference. Every field below was ANSWERED by the server. ────
  /** Who we are connected AS. Present only when the provider actually told us
   *  (an OIDC id_token or a userinfo endpoint). NEVER fabricated: a connection
   *  we cannot name renders as connected-without-an-account, not as a guess. */
  account?: string
  /** The server's own name from `initialize`. */
  serverName?: string
  /** How many tools it served at `tools/list` — the live proof it works. */
  toolCount?: number
  /** The tools' NAMES, as the server listed them — full observability of what an
   *  agent can actually do through this connection, not a bare count. Names only
   *  (no schemas), capped, and strictly local: they render on the card and never
   *  ride telemetry (ADR 0005 — counts and booleans only). */
  tools?: string[]
  /** Scopes the grant actually carries (from the token response). */
  scopes?: string[]
  connectedAt?: number
  /** Access-token expiry. The app refreshes in the background; the card counts
   *  down. Absent when the provider issues a non-expiring credential. */
  expiresAt?: number
  /** The last failure, worded for a human. Cleared on the next success. */
  lastError?: string
  /** For `key` connections: the env NAME whose vault slot holds the key. */
  keyName?: string
  /** An `oauth` service that ALSO takes a pasted key (GitHub's PAT, Sentry's auth
   *  token). The card offers the key path as a secondary verb — without this flag
   *  the PAT on-ramp existed in main but was unreachable from any pixel. */
  hasKeyOption?: boolean
  /** The Authorization scheme the server actually accepted for a pasted key —
   *  discovered at connect (Bearer for almost everyone; `Key` for fal.ai). The
   *  proxy reuses it so agent calls don't re-guess. Never a secret. */
  authScheme?: string
  /** A self-hosted service (n8n, Make): the card needs the instance URL before
   *  any credential means anything. */
  needsBaseUrl?: boolean
  /** OAuth only: the provider's sign-in server offers no dynamic registration
   *  (RFC 7591) and no client is stored for it yet — Google, GitHub, Slack. Connect
   *  cannot proceed, so the card offers the client-id form instead of a Reconnect
   *  button that can only fail the same way again. */
  needsClientId?: boolean
  /** The issuer this connection signs in at (e.g. https://accounts.google.com), set
   *  once discovery has run. It names WHOSE console a client id must come from — and
   *  because client records are keyed by issuer, one pasted client covers every
   *  service that signs in at the same place. Never a secret. */
  authServer?: string
  /** True when the stored OAuth client was pasted by the user from the provider's
   *  own console, rather than dynamically registered. The card offers "Forget
   *  client ID", and a redirect mismatch must NOT purge it (the user typed it; we
   *  cannot re-register to get it back). */
  userClient?: boolean
}

/** The one place a connection's OAuth client registration is remembered. Per
 *  AUTHORIZATION SERVER, not per service: two services behind one AS share it. */
export interface OAuthClientRecord {
  authServer: string
  clientId: string
  /** Public clients (PKCE, no secret) are the norm and the preference. */
  clientSecret?: string
  registeredAt: number
  /** How the record came to exist: `dcr` — the app registered itself (RFC 7591);
   *  `user` — pasted from the provider's own console, for the servers that offer no
   *  DCR (Google, GitHub, Slack). Absent means `dcr` (records that predate the
   *  field). The distinction is load-bearing: a `dcr` record can be purged and
   *  re-registered on a redirect mismatch, a `user` record cannot — purging it
   *  would eat credentials only the user can restore. */
  source?: 'dcr' | 'user'
}

/** Is this connection usable right now, or does it need the user? */
export const connectionNeedsUser = (c: Connection): boolean =>
  c.state === 'disconnected' || c.state === 'expired' || c.state === 'error'

/** Minutes until the access token expires, or null when it does not expire.
 *  Negative means already expired — the refresher is late, not the clock. */
export function connectionExpiresInMinutes(c: Connection, now: number = Date.now()): number | null {
  if (!c.expiresAt) return null
  return Math.round((c.expiresAt - now) / 60_000)
}

/**
 * WHOSE account this is — the line a user scans to answer "am I logged in as the right
 * one?". This is the whole point of a connection card, so it gets its own line and its
 * own function rather than being buried in a summary string. It is an EMAIL wherever the
 * provider will give us one (unambiguous in a way a display name is not), a display name
 * otherwise, qualified by the workspace when there is one.
 *
 * Returns null when the provider genuinely never told us. That happens: most MCP servers
 * are not OIDC, and a server with no whoami-style tool has no way to name its user. A
 * card that says "Connected" is honest. A card that invents a name is not, and would be
 * worse than saying nothing — it is the one thing on this page a user MUST be able to
 * trust, because acting as the wrong account is how an agent does real damage.
 */
export const connectionAccount = (c: Connection): string | null =>
  c.state === 'connected' ? (c.account ?? null) : null

/** Why no account name is showing on a connected card. Shown in place of the name, so
 *  the silence is explained rather than merely blank. */
export const NO_ACCOUNT_NOTE = 'Signed in — this provider doesn’t share an account name.'

/**
 * The client-ID paste form's guidance — written by the contract, like every other card
 * sentence, so the form and the backend's redirect-mismatch advice can never tell two
 * different stories about whose console the client comes from or which type to create.
 * Provider-specific wording is keyed on the ISSUER the card already carries.
 */
export function clientFormHelp(authServer?: string): string {
  let host: string | null = null
  try {
    host = authServer ? new URL(authServer).host : null
  } catch {
    host = null
  }
  if (host && /(^|\.)google\.com$/.test(host)) {
    return (
      'Create an OAuth client in Google Cloud Console (APIs & Services → Credentials → ' +
      'Create credentials → OAuth client ID → “Desktop app”) and paste it here. ' +
      'One client covers every Google service on this page.'
    )
  }
  const name = host ?? 'the provider'
  return (
    `Create an OAuth client in ${name}'s developer console — it must allow loopback ` +
    `redirect URLs (http://127.0.0.1) — and paste it here. One client covers every ` +
    `service that signs in at ${name}.`
  )
}

/** The card's supporting line: what the server answered, and when the grant renews. */
export function connectionSummary(c: Connection, now: number = Date.now()): string {
  switch (c.state) {
    case 'connected': {
      const parts: string[] = []
      if (c.toolCount != null) parts.push(`${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}`)
      const mins = connectionExpiresInMinutes(c, now)
      if (mins != null) parts.push(mins > 0 ? `renews in ${mins}m` : 'renewing…')
      else parts.push('does not expire')
      return parts.join(' · ')
    }
    case 'connecting':
      return 'Waiting for you to finish in the browser…'
    case 'expired':
      return 'The connection expired — reconnect to renew it.'
    case 'error':
      return c.lastError ?? 'The last attempt failed.'
    default:
      // `local` here always means a REMOTE no-account server (stdio presets never
      // reach the grid) — the old copy claimed it "runs on your machine's own
      // credentials", which was simply false for e.g. Cloudflare's docs server,
      // and the card offered no button at all for something one click could enable.
      return c.authKind === 'local'
        ? 'No account needed — connect to make it available to your agents.'
        : 'Not connected.'
  }
}

/** What this grant is actually allowed to do, in the provider's own words. The other
 *  half of "which account": being signed in as the right person with the wrong powers
 *  is still the wrong connection. Empty when the provider scoped it implicitly. */
export const connectionScopes = (c: Connection): string[] => (c.state === 'connected' ? (c.scopes ?? []) : [])

// ── The connect lifecycle, in two phases (ADR 0014) ─────────────────────────
// A connection is CONNECTED the instant its grant lands — proven by the grant, not
// by a follow-up tools/list. Deriving "connected" from an enrichment probe was one
// bug wearing three masks: it held the card on "connecting…" for the length of two
// extra round trips; it demoted a valid grant to "error" whenever the probe failed
// for reasons unrelated to the grant (Google gates tools at CALL time; a userinfo
// endpoint can simply be slow); and it kept the flow "pending" through that window,
// so a Cancel could set "disconnected" only to be overwritten by the late probe.
// These two builders split the decision cleanly, and the CONNPURE gate bites them.

/**
 * PHASE 1 — the patch that marks a connection CONNECTED the moment its grant lands,
 * BEFORE any enrichment. It carries what the grant itself proves (scopes, expiry,
 * which issuer it signs in at, whether the client was the user's own) and deliberately
 * NOT the account name, tool names, or tool count — those are answered by the server
 * later, over {@link connectionEnrichmentPatch}, and a connection is no less connected
 * for not yet knowing them. `needsClientId` and `lastError` are cleared: a landed grant
 * has neither an unmet prerequisite nor a live failure.
 */
export function grantLandedPatch(g: {
  scopes?: string[]
  expiresAt?: number
  connectedAt: number
  authServer: string
  userClient: boolean
}): Partial<Connection> {
  return {
    state: 'connected',
    scopes: g.scopes,
    expiresAt: g.expiresAt,
    connectedAt: g.connectedAt,
    authServer: g.authServer,
    userClient: g.userClient || undefined,
    needsClientId: undefined,
    lastError: undefined
  }
}

/**
 * PHASE 2 — the best-effort enrichment merged onto an ALREADY-connected card: whose
 * account this is, and what the server serves. It NEVER carries `state`: a probe that
 * fails (a quota error, an SSE hiccup, a slow whoami) says nothing about the grant's
 * validity and must not un-connect it. Blanks are left blank — an answer we didn't get
 * is never written as `undefined` over a value the card is already showing. (The one
 * failure that DOES mean the grant is bad — an unauthorized resource — is handled by
 * the caller, which downgrades to `expired`; it is not an enrichment field.)
 */
export function connectionEnrichmentPatch(e: {
  account?: string | null
  serverName?: string
  toolCount?: number
  tools?: string[]
}): Partial<Connection> {
  const patch: Partial<Connection> = {}
  if (e.account) patch.account = e.account
  if (e.serverName) patch.serverName = e.serverName
  if (typeof e.toolCount === 'number') patch.toolCount = e.toolCount
  if (e.tools) patch.tools = e.tools
  return patch
}

/** Guard for the phase-2 write: is the card still the SAME landed grant we enriched
 *  for? A Disconnect or a fresh connect during the enrichment round trips changes the
 *  state or the connect stamp, and a stale answer must not overwrite it. */
export const enrichmentTargetsSameGrant = (current: Connection | null | undefined, connectedAt: number): boolean =>
  !!current && current.state === 'connected' && current.connectedAt === connectedAt
