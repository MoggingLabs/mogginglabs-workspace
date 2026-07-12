import type { ServiceLinkKind } from '@contracts'

// Parse a pasted GitHub URL or `owner/repo#123` shorthand into a normalized
// ref (Phase-8/12). The ref is structural ("owner/repo#123") — repo names and
// URLs stay out of telemetry (ADR 0005). Returns null for anything we can't
// resolve, so the UI shows a clean "couldn't read that".

const SEG = '[A-Za-z0-9._-]+'
const URL_RE = new RegExp(`^https?://github\\.com/(${SEG})/(${SEG})/(pull|issues)/(\\d+)`, 'i')
const SHORT_RE = new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`)

export function parseServiceLink(input: string): { ref: string; kind: ServiceLinkKind } | null {
  const t = String(input ?? '').trim()
  if (!t) return null
  const u = URL_RE.exec(t)
  if (u) return { ref: `${u[1]}/${u[2]}#${u[4]}`, kind: u[3].toLowerCase() === 'issues' ? 'issue' : 'pr' }
  // The shorthand cannot say pr vs issue (GitHub shares the number space), so it
  // GUESSES pr — and github.ts corrects it on the first fetch: a pr view that
  // reports not-found retries as an issue and repairs the link's kind.
  const s = SHORT_RE.exec(t)
  if (s) return { ref: `${s[1]}/${s[2]}#${s[3]}`, kind: 'pr' }
  return null
}

/** Split a normalized ref back into parts for an adapter query. */
export function refParts(ref: string): { owner: string; repo: string; number: number } | null {
  const m = new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`).exec(ref)
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null
}
