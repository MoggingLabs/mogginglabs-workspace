/**
 * The one answer to "may this URL be handed to something that will act on it?"
 *
 * Three near-identical predicates existed — `validConnectionUrl` (connections.ts),
 * `normalizeUrl` (browser-dock.ts), and a bare `startsWith('https://')` in the provider
 * catalog — and none of them guarded the sinks that mattered.
 *
 * `shell.openExternal` hands a string to the OPERATING SYSTEM, which picks a program by
 * scheme. `ms-msdt:`, `file:`, `search-ms:` and friends are not "a page that fails to load";
 * they are another program, launched with an argument the remote side chose.
 *
 * Both OAuth sinks took one:
 *
 *   - `authorization_endpoint` is fully remote-supplied. Discovery follows the 401's
 *     `resource_metadata` pointer to an authorization server, fetches its metadata, and the
 *     only check was that the field was PRESENT. `new URL()` keeps any scheme.
 *   - `verification_uri` / `verification_uri_complete` come raw from a device-code RESPONSE
 *     BODY. The request host is pinned by the catalog; the response content is not.
 *
 * So the rule lives in one place, is applied at the SOURCE (metadata is rejected on arrival)
 * and re-asserted at each sink — because a predicate that is only checked once is only correct
 * until someone adds a second caller.
 */

/** http is allowed ONLY on loopback: that is the OAuth redirect receiver we start ourselves. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The normalized href if this URL may be opened or fetched, else null.
 *
 * Deliberately NOT a boolean: returning the parsed href means callers use what was validated
 * rather than re-parsing the raw string, which is how a check and its subject drift apart.
 */
export function httpsOrLoopbackUrl(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol === 'https:') return u.href
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u.href
  return null
}

/** Shape of the authorization-server metadata this guard inspects. Structural on purpose —
 *  the real type lives in the integrations feature, and core/net must not import a feature. */
interface AuthServerEndpoints {
  authorization_endpoint?: string
  token_endpoint?: string
  device_authorization_endpoint?: string
  registration_endpoint?: string
}

export type MetadataVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Reject an authorization server whose endpoints are not URLs we would open or POST to.
 *
 * Applied where the metadata ARRIVES, so a bad server is refused once with a nameable reason,
 * rather than surviving until someone opens the browser with it. Presence was the entire check.
 */
export function validateAuthServerMetadata(meta: AuthServerEndpoints | null | undefined): MetadataVerdict {
  if (!meta) return { ok: false, reason: 'no authorization-server metadata' }
  const required: Array<keyof AuthServerEndpoints> = ['authorization_endpoint', 'token_endpoint']
  for (const field of required) {
    const value = meta[field]
    if (!value) return { ok: false, reason: `authorization server is missing ${field}` }
    if (!httpsOrLoopbackUrl(value)) return { ok: false, reason: `authorization server's ${field} is not an https URL` }
  }
  // Optional endpoints are checked when present: an absent one is a server that does not offer
  // that grant, which is fine; a malformed one is a server we must not follow.
  for (const field of ['device_authorization_endpoint', 'registration_endpoint'] as const) {
    const value = meta[field]
    if (value && !httpsOrLoopbackUrl(value)) {
      return { ok: false, reason: `authorization server's ${field} is not an https URL` }
    }
  }
  return { ok: true }
}
