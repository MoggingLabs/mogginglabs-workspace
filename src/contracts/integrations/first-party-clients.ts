// The first-party OAuth clients (ADR 0014, extended) — the data that turns
// "Connect" back into a button.
//
// THE PROBLEM THIS SOLVES. Most of the catalog registers itself (RFC 7591) and
// needs nothing from anybody. The biggest vendors — github.com, Slack,
// accounts.google.com — offer no dynamic registration at all, and the app's only
// answer was a paste form: *go to GitHub, create an OAuth app, copy the client
// id, copy the client secret, come back*. That is five minutes of vendor
// paperwork standing between a user and a button, and it is the single most
// common reason a card never gets connected.
//
// `gh auth login` does not do that, and neither should we. The GitHub CLI ships
// its OWN public client id, baked into the binary, and drives the device flow
// with it. So do we.
//
// ── WHY SHIPPING THIS IS NOT SHIPPING A SECRET ──────────────────────────────
//
// ADR 0014 refuses to ship "a client secret in a bundle every user can read",
// and that refusal stands word for word. A public client **id** is a different
// object: OAuth 2.1 §2.1 classifies a native app as a PUBLIC client precisely
// because it cannot hold a secret, and RFC 8252 §8.4 says so in as many words —
// the id is an identifier, not a credential. It authorizes nothing on its own.
// Every native app that has ever done this (gh, aws, gcloud, the Docker CLI)
// ships one, and it is why their sign-in is one command.
//
// The two rules that keep it honest, both enforced below:
//   1. **NEVER a secret here.** `firstPartyClientFor` returns a record with no
//      `clientSecret`, structurally — the type has no slot for one. A vendor
//      that cannot do device flow without a secret does not get a first-party
//      client; it keeps the paste form, which is the honest answer.
//   2. **NEVER persisted.** A shipped client is app DATA, not user state. It is
//      resolved fresh every flow and never written to the client store, so an
//      app update can rotate it and a stale record can never pin a revoked id.
//
// ── FILLING THIS IN ─────────────────────────────────────────────────────────
//
// An entry with an empty `clientId` is INERT: `firstPartyClientFor` returns null
// and the connect flow falls back to exactly today's behaviour (DCR, then the
// paste form). So this table ships safe and half-filled, and turning a provider
// into a one-button connect is a one-line data change plus a registration in
// that vendor's console. See docs/14-integrations.md for the per-vendor steps.

/** A shipped, PUBLIC OAuth client. No secret slot, by construction — see rule 1. */
export interface FirstPartyClient {
  /** The AS issuer this client belongs to, as it appears in RFC 8414 metadata. */
  issuer: string
  /** The public client id. EMPTY = not yet registered; the entry stays inert. */
  clientId: string
  /** Which vendor console this was registered in, for the humans maintaining it. */
  registeredIn: string
  /** Why this provider needs a shipped client instead of registering itself. */
  because: string
}

/**
 * Keyed by ISSUER, matching the client store's own key — two services behind one
 * sign-in server share one client (all of Google Workspace is one entry).
 *
 * PROVENANCE: every issuer string below is what that vendor's own RFC 8414
 * metadata reports, verified 2026-07-31 (`/.well-known/oauth-authorization-server`).
 */
export const FIRST_PARTY_CLIENTS: readonly FirstPartyClient[] = [
  {
    issuer: 'https://github.com/login/oauth',
    // ─────────────────────────────────────────────────────────────────────────
    // TO ENABLE ONE-BUTTON GITHUB: register an OAuth App at
    //   https://github.com/settings/applications/new
    // and tick "Enable Device Flow". Paste the Client ID here. Do NOT paste the
    // client secret — the device flow does not use one, and this file must never
    // hold one (rule 1 above; the CATSCHEMA secret scan enforces it).
    // ─────────────────────────────────────────────────────────────────────────
    clientId: '',
    registeredIn: 'https://github.com/settings/developers',
    because: 'github.com offers no dynamic client registration (RFC 7591).'
  }
]

/** An env override, so a self-hosted or development build can point at its own
 *  registered app without editing the bundle. `MOGGING_OAUTH_CLIENT_GITHUB_COM`
 *  for `https://github.com/login/oauth`, etc. */
export function firstPartyClientEnvName(issuer: string): string {
  let host = issuer
  try {
    host = new URL(issuer).hostname
  } catch {
    /* not a URL — fall back to the raw string, sanitized below */
  }
  return `MOGGING_OAUTH_CLIENT_${host.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

/**
 * The shipped client id for an issuer, or null when we have none — which is the
 * signal to fall through to dynamic registration and then the paste form.
 *
 * `env` is injected so this stays pure and the gate can drive the override
 * without touching `process.env`.
 */
export function firstPartyClientFor(
  issuer: string,
  env: Readonly<Record<string, string | undefined>> = {}
): FirstPartyClient | null {
  const key = String(issuer ?? '').trim()
  if (!key) return null
  const entry = FIRST_PARTY_CLIENTS.find((c) => c.issuer === key)
  const override = String(env[firstPartyClientEnvName(key)] ?? '').trim()
  // The override wins even for an issuer with no table row: that is how a fork
  // or a self-hosted build adds a provider we never registered.
  if (override) {
    return {
      issuer: key,
      clientId: override,
      registeredIn: entry?.registeredIn ?? '(environment override)',
      because: entry?.because ?? 'Supplied by the environment.'
    }
  }
  // An empty clientId is INERT — the table row exists to document the provider
  // and to be one line away from working, not to hand out a blank id.
  return entry && entry.clientId ? entry : null
}
