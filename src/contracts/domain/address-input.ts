/**
 * The address bar's omnibox rule (F3): decide whether what the user typed is a URL
 * to open or a search to run, the way Comet/Chrome do. Pure and shared — the
 * renderer commits from it and any test asserts the exact same decision.
 *
 * The heuristics, in order:
 *  - Whitespace anywhere → a search (no URL has a space).
 *  - An explicit http(s):// → a URL, verbatim.
 *  - Any OTHER explicit scheme (mailto:, about:, ftp://, data:) → a search; the dock
 *    opens only http(s). The one trap: `localhost:3000` LOOKS like `scheme:opaque`,
 *    so a colon followed by a port (digits) is treated as host:port, not a scheme.
 *  - localhost / an IP / a dotted host, optionally with a port → a URL. https FIRST
 *    (the modern default), except a dev server (localhost / IP / explicit port),
 *    which takes http.
 *  - Anything else — a dotless word — is a search.
 */

export type AddressResolution =
  | { kind: 'url'; url: string }
  | { kind: 'search'; query: string }

/** The default omnibox search engine — DuckDuckGo (no query logging, in keeping with
 *  the product's neutral-and-private stance; ADR 0002/0005). `%s` is the query slot.
 *  A future setting can override it per install. */
export const DEFAULT_SEARCH_TEMPLATE = 'https://duckduckgo.com/?q=%s'

/** Build a search URL for the engine template (a string containing `%s`). */
export function searchUrlFor(template: string, query: string): string {
  return template.replace('%s', encodeURIComponent(query))
}

const LOOKS_LIKE_HOST = /^[^\s/]+\.[^\s/]+/ // a dot-bearing token before any slash
const IS_LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:\d+)?(\/|$)/i
const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+|\/|$)/
const HAS_PORT = /^[^\s/]+:\d+(\/|$)/
// A leading `scheme:` where scheme starts with a letter. Captures the remainder so a
// port (all digits → host:port, NOT a scheme) can be told from a real scheme.
const SCHEMEISH = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/

/** A dev server (localhost / IP / explicit port) defaults to http — TLS usually
 *  isn't running there; every other scheme-less host defaults to https. */
function prefersHttp(hostish: string): boolean {
  return IS_LOCAL_HOST.test(hostish) || IS_IPV4.test(hostish) || HAS_PORT.test(hostish)
}

function maybeUrl(withScheme: string): AddressResolution | null {
  try {
    const u = new URL(withScheme)
    if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'url', url: u.href }
  } catch {
    /* not a URL after all */
  }
  return null
}

export function resolveAddressInput(raw: string): AddressResolution | null {
  const t = raw.trim()
  if (!t) return null
  const search: AddressResolution = { kind: 'search', query: t }
  if (/\s/.test(t)) return search

  // Explicit web scheme → open verbatim.
  if (/^https?:\/\//i.test(t)) return maybeUrl(t) ?? search

  // A leading `scheme:` that is NOT a host:port is a scheme we don't open → search. It's
  // only host:port when the part after the colon is a port (digits) AND the part before it
  // is a plausible host — so `localhost:3000`/`example.com:8080` fall through, but `tel:911`,
  // `sms:12345`, `about:blank` are schemes and search.
  const m = SCHEMEISH.exec(t)
  if (m) {
    const isHostPort = /^\d+(\/|$)/.test(m[2]) && (IS_LOCAL_HOST.test(t) || IS_IPV4.test(t) || m[1].includes('.'))
    if (!isHostPort) return search
  }

  if (IS_LOCAL_HOST.test(t)) return maybeUrl(`http://${t}`) ?? search
  if (!LOOKS_LIKE_HOST.test(t) && !HAS_PORT.test(t)) return search
  // A scheme-less authority with userinfo (`user@host`, and the phishing shape
  // `trusted.com@evil.com`) is ambiguous — searching it is safer than silently
  // navigating to `host`, which is where the browser would actually go.
  if (t.split('/')[0].includes('@')) return search
  return maybeUrl(`${prefersHttp(t) ? 'http' : 'https'}://${t}`) ?? search
}
