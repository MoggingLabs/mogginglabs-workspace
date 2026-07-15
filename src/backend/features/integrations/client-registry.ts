import type { OAuthClientRecord } from '@contracts'
import { registerClient, type AuthServerMetadata } from './oauth'

// The OAuth CLIENT ledger (ADR 0014, extended): where a connection's client
// registration comes from, and the rules that keep the two kinds honest.
//
// Most of the catalog registers ITSELF (RFC 7591) — no vendor paperwork, no
// shipped secret. But the biggest vendors offer no dynamic registration at all:
// accounts.google.com, github.com and Slack each require a client the USER
// creates once in the vendor's own console and pastes here. Both kinds land in
// the same per-issuer store; both drive the same PKCE flow. The differences are
// exactly two, and both live in this file so the gate can bite on them:
//
//   1. WHEN there is no record and no DCR, the failure must be ACTIONABLE — a
//      structured `needsClientId`, not a prose-only dead end. The card renders a
//      paste form off that flag; a Reconnect button there could only fail the
//      same way forever.
//   2. WHAT may be purged. A `dcr` record is disposable: on a redirect-uri
//      mismatch we throw it away and re-register against the current loopback
//      port. A `user` record is NOT ours to destroy — purging it would eat
//      credentials only the user can restore, and "try again" would then mean
//      "go find your client secret again". It survives; the advice changes.
//
// Electron-free on purpose, like oauth.ts: the store is an injected interface,
// so the regression gate drives every branch with an in-memory store and a
// fixture authorization server — no app, no keychain, no network beyond loopback.

/** Where client records rest. The app backs this with the OS-keychain vault,
 *  keyed per ISSUER (two services behind one sign-in server share one record —
 *  all of Google Workspace is one client). `save` returns false when the store
 *  refuses (no keychain), and the caller must treat that as a hard stop: a
 *  client secret never rests in plaintext. */
export interface ClientStore {
  load(issuer: string): OAuthClientRecord | null
  save(issuer: string, record: OAuthClientRecord): boolean
  clear(issuer: string): void
}

/**
 * A pasted client id/secret, held to the few rules that catch real paste
 * accidents without second-guessing any provider's format:
 *   · the id is required, trimmed, and must be ONE token — an id with internal
 *     whitespace is a sentence or a double-paste, never a client id;
 *   · a pasted paragraph is refused by length rather than stored and sent to a
 *     provider that will refuse it less legibly;
 *   · the secret is optional (public clients exist), trimmed, and an empty or
 *     whitespace-only secret is NO secret — `""` must never reach a token
 *     request as a literal empty `client_secret`.
 */
export function sanitizeUserClient(
  clientId: unknown,
  clientSecret?: unknown
): { ok: true; clientId: string; clientSecret?: string } | { ok: false; reason: string } {
  const id = String(clientId ?? '').trim()
  if (!id) return { ok: false, reason: 'Paste the client ID first.' }
  if (/\s/.test(id)) return { ok: false, reason: 'A client ID is a single token — the pasted value contains spaces.' }
  if (id.length > 256) return { ok: false, reason: 'That does not look like a client ID (it is far too long).' }
  const secret = String(clientSecret ?? '').trim()
  if (secret.length > 512) return { ok: false, reason: 'That does not look like a client secret (it is far too long).' }
  return { ok: true, clientId: id, clientSecret: secret || undefined }
}

/** The record a pasted client becomes. `registeredAt` is when the USER registered
 *  it with us — the vendor-side creation time is theirs and unknowable. */
export const userClientRecord = (issuer: string, clientId: string, clientSecret?: string): OAuthClientRecord => ({
  authServer: issuer,
  clientId,
  ...(clientSecret ? { clientSecret } : {}),
  registeredAt: Date.now(),
  source: 'user'
})

/**
 * The client for a flow: stored record first (either kind), dynamic registration
 * second, and an ACTIONABLE refusal when neither exists. `needsClientId` is set
 * only for the no-DCR case — a network failure to a live registration endpoint
 * must NOT render the paste form, because pasting a client id would not fix it.
 */
export async function resolveClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  store: ClientStore
): Promise<{ ok: true; client: OAuthClientRecord } | { ok: false; reason: string; needsClientId?: true }> {
  const cached = store.load(metadata.issuer)
  if (cached) return { ok: true, client: cached }
  const reg = await registerClient(metadata, redirectUri)
  if (!reg.ok) {
    return metadata.registration_endpoint ? reg : { ok: false, reason: reg.reason, needsClientId: true }
  }
  const record: OAuthClientRecord = { ...reg.client, source: 'dcr' }
  if (!store.save(metadata.issuer, record)) {
    return { ok: false, reason: 'The OS keychain would not hold the client registration.' }
  }
  return { ok: true, client: record }
}

/** May a redirect-uri mismatch purge this record? Only when we can get another
 *  one ourselves. Absent `source` means a pre-existing DCR record — purgeable. */
export const canRepairClientByReRegistering = (client: OAuthClientRecord): boolean => client.source !== 'user'

/** The sentence for a redirect-uri mismatch, matched to what "try again" will
 *  actually do. For a DCR client the app re-registers, so try-again is real
 *  advice. For a pasted client nothing we do changes the vendor's redirect
 *  allowlist — the user must let their client accept loopback redirects (for
 *  Google: the client's application type must be "Desktop app"). A vendor whose
 *  console cannot allow loopback redirect URLs at all (Slack) cannot connect on
 *  this route, and the honest sentence says so instead of sending the user to
 *  look for a setting that does not exist. */
export const redirectDriftAdvice = (client: OAuthClientRecord, reason: string): string =>
  canRepairClientByReRegistering(client)
    ? `${reason} — try Connect again (we re-register with the provider).`
    : `${reason} — your OAuth client must accept loopback redirects (http://127.0.0.1). For Google, create it as a “Desktop app” client and try again. If the provider's console cannot allow loopback redirect URLs at all, this route cannot connect it — use the per-CLI path instead.`
