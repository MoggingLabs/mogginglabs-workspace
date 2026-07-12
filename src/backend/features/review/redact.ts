// Secret redaction for diff review (Phase-3/04). PURE — no I/O, no state. Every diff
// leaves the backend ONLY after this pass; a planted credential must never reach the
// renderer, the DOM, telemetry, or a log. Patterns live in this one reviewed module
// and are unit-asserted by the MOGGING_REVIEW smoke.

export const REDACTED = '«redacted»'

// Order matters: multi-line PEM blocks first, then specific token shapes, then the
// generic key=value scrub (which would otherwise eat parts the specific rules label).
const PATTERNS: RegExp[] = [
  // PEM private keys (any type), whole block
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // AWS access key id + GCP API key
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // GitHub tokens (classic + fine-grained), OpenAI/Anthropic-style, Slack
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWT-shaped triplets
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g
]

// Authorization / Proxy-Authorization headers — the scheme is kept, the token replaced.
const AUTH_HEADER = /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)((?:basic|bearer|token)\s+)?([A-Za-z0-9._~+/=-]{8,})/gi

// password/token/secret/api_key = <value> pairs — the VALUE is replaced, the key kept.
// The key side matches a WHOLE identifier (AWS_SECRET_ACCESS_KEY, DB_PASSWORD, apiToken)
// and the callback checks its segments against the keyword list — a leading `\b(token)`
// never matches after `_` (a word character), which let every SCREAMING_SNAKE secret
// name straight through. Segment matching (not substring) keeps `author`/`monotonic`
// style identifiers unredacted. Values may be bare (no spaces, as before) or quoted
// (spaces allowed — `password = "two words"` previously escaped the scrub).
const KV_KEYWORDS = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'auth', 'credential', 'credentials'])
const KV = /([A-Za-z][A-Za-z0-9_.-]*)((?:["']?)\s*[:=]\s*)(?:(["'])((?:(?!\3).){4,}?)\3|([^\s"'`;,)}\]]{4,}))/g

function keyLooksSecret(key: string): boolean {
  // Split on separators and camelCase boundaries; also try joining adjacent
  // segments so `api_key`/`api-key`/`apiKey` all hit the `apikey` keyword.
  const segs = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    if (KV_KEYWORDS.has(segs[i])) return true
    if (i + 1 < segs.length && KV_KEYWORDS.has(segs[i] + segs[i + 1])) return true
  }
  return false
}

/** Scrub secrets from arbitrary text. Returns the clean text + how many hits. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0
  let out = text
  for (const re of PATTERNS) {
    out = out.replace(re, () => {
      redactions++
      return REDACTED
    })
  }
  out = out.replace(AUTH_HEADER, (_m, key: string, sep: string, scheme: string | undefined) => {
    redactions++
    return `${key}${sep}${scheme ?? ''}${REDACTED}`
  })
  out = out.replace(KV, (m, key: string, sep: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    if (!keyLooksSecret(key)) return m
    redactions++
    const q = quoted !== undefined ? (quote as string) : ''
    void bare
    return `${key}${sep}${q}${REDACTED}${q}`
  })
  return { text: out, redactions }
}
