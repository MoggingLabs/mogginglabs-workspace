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

// password/token/secret/api_key = <value> pairs — the VALUE is replaced, the key kept.
const KV = /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|credential)((?:["']?)\s*[:=]\s*)(["']?)([^\s"'`;,)}\]]{4,})\3/gi

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
  out = out.replace(KV, (_m, key: string, sep: string, quote: string) => {
    redactions++
    return `${key}${sep}${quote}${REDACTED}${quote}`
  })
  return { text: out, redactions }
}
