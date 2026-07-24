// The identity ladder (ADR 0020, phase-tools/04) — Metorial's getProfile model, as
// data: ONE executor reads the service's catalog `profile` spec and returns the
// normalized {id, email, name, imageUrl}, recording which rung answered. Rungs, in
// order:
//
//   · oidc — claims already in hand (the id_token that rode the grant): free, local;
//   · rest — the provider's own identity endpoint, with JSON paths from the catalog
//     (GitHub `.email||.login`, Slack auth.test, Google userinfo…). A catalog `oidc`
//     spec that names a userinfo URL rides the same fetch and still reports `oidc`;
//   · tool — an MCP whoami-shaped tool, ONLY when the catalog names it or the
//     server's own tools/list served a name on the small pinned allowlist. One call,
//     empty args, short timeout, tolerant reader — never speculative, never retried.
//
// Every rung is best-effort enrichment (CONNPURE): a failure means "try the next",
// malformed JSON means a blank, and nothing here ever throws into the caller.
// Adding a provider's identity is a data PR — no code changes, ever (the guardrail).
//
// The TOOLWHO gate bites the ladder against fixtures, including a LIVE mutation-red
// proof that the tool-rung allowlist is load-bearing (a broken match must make the
// no-whoami fixture receive calls the gate then catches).

import type { AccountProfile, AccountSource, ProviderProfileSpec } from '@contracts'
import { WHOAMI_TOOLS, mcpFetch } from './oauth'

// ── Reading a provider's answer into the normalized shape ────────────────────

/** One JSON path: dot notation, with `a||b` fallback chains (first non-empty wins).
 *  Values are coerced to short strings — GitHub's numeric `id` is a real id. */
export function readPath(obj: unknown, path: string | undefined): string | undefined {
  if (!path) return undefined
  for (const candidate of path.split('||').map((p) => p.trim()).filter(Boolean)) {
    let node: unknown = obj
    for (const key of candidate.split('.')) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        node = undefined
        break
      }
      node = (node as Record<string, unknown>)[key]
    }
    if (typeof node === 'string' && node.trim()) return node.trim().slice(0, 200)
    if (typeof node === 'number' && Number.isFinite(node)) return String(node)
  }
  return undefined
}

/** The catalog paths, applied. A profile with no identifying field at all is null —
 *  an empty object must never render as "signed in as". */
export function readProfilePaths(obj: unknown, paths: ProviderProfileSpec['paths']): AccountProfile | null {
  const profile: AccountProfile = {
    ...(readPath(obj, paths?.id) ? { id: readPath(obj, paths?.id) } : {}),
    ...(readPath(obj, paths?.email) ? { email: readPath(obj, paths?.email) } : {}),
    ...(readPath(obj, paths?.name) ? { name: readPath(obj, paths?.name) } : {}),
    ...(readPath(obj, paths?.imageUrl) ? { imageUrl: readPath(obj, paths?.imageUrl) } : {})
  }
  return profile.id || profile.email || profile.name ? profile : null
}

const ID_KEYS = new Set(['id', 'sub', 'user_id', 'userid', 'account_id', 'distinct_id'])
const EMAIL_KEYS = new Set(['email', 'email_address', 'emailaddress', 'mail', 'upn', 'userprincipalname'])
const NAME_KEYS = new Set(['name', 'display_name', 'displayname', 'full_name', 'fullname', 'preferred_username', 'username', 'login', 'handle', 'nickname', 'user'])
const IMAGE_KEYS = new Set(['avatar_url', 'avatarurl', 'picture', 'image', 'imageurl', 'image_url', 'photo'])

/** A pathless answer (an id_token's claims, a whoami tool's JSON) read generically:
 *  a shallow walk collecting each field independently — the pickIdentity lesson
 *  (Notion nests the email DEEPER than the display name; never stop at first hit). */
export function profileFromLoose(obj: unknown): AccountProfile | null {
  if (!obj || typeof obj !== 'object') return null
  const found: Record<string, string> = {}
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 3) return
    seen.add(node)
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const key = k.toLowerCase()
      const val = typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null
      if (val) {
        if (ID_KEYS.has(key) && !found.id) found.id = val
        else if (EMAIL_KEYS.has(key) && !found.email) found.email = val
        else if (NAME_KEYS.has(key) && !found.name) found.name = val
        else if (IMAGE_KEYS.has(key) && !found.imageUrl) found.imageUrl = val
      }
      if (v && typeof v === 'object') walk(v, depth + 1)
    }
  }
  walk(obj, 0)
  return found.id || found.email || found.name ? (found as AccountProfile) : null
}

/** An id_token's payload as a profile. Unverified-by-design and safe for the same
 *  reason discoverAccount documents: it arrived over TLS from our own PKCE-proven
 *  exchange, and it authorizes nothing — it names a card. */
export function profileFromJwt(jwt: string | undefined): AccountProfile | null {
  if (!jwt) return null
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3 || !parts[1]) return null
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return profileFromLoose(JSON.parse(json))
  } catch {
    return null
  }
}

/** The computed one-line fallback the old `account` string consumers keep reading:
 *  email preferred (the unambiguous identifier), else name. */
export const profileDisplay = (p: AccountProfile): string | null => p.email ?? p.name ?? null

// ── The tool rung's gate ─────────────────────────────────────────────────────

/**
 * Which tool may be asked "who am I?" — the catalog-named tool when the server
 * actually serves it, else the first tools/list name on the pinned allowlist.
 * Null means NO call happens: the rung is never speculative.
 *
 * `_testBreakAllowlist` is TEST-ONLY (the TOOLWHO mutation-red): it matches ANY
 * tool, which is exactly the fishing expedition the gate must catch.
 */
export function whoamiToolPick(
  toolNames: readonly string[],
  catalogTool: string | undefined,
  o: { _testBreakAllowlist?: boolean } = {}
): string | null {
  if (o._testBreakAllowlist) return toolNames[0] ?? null
  if (catalogTool) {
    const hit = toolNames.find((t) => t.toLowerCase() === catalogTool.toLowerCase())
    if (hit) return hit
  }
  return toolNames.find((t) => WHOAMI_TOOLS.has(t.toLowerCase())) ?? null
}

/** One whoami tool call: its own short session, empty args, tolerant reader.
 *  Anything unparseable is a blank, never an error. */
export async function callWhoamiTool(
  url: string,
  name: string,
  o: { token?: string; authScheme?: string; timeoutMs?: number } = {}
): Promise<unknown | null> {
  const timeoutMs = o.timeoutMs ?? 10_000
  const init = await mcpFetch(
    url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'MoggingLabs Workspace', version: '1' } }
    },
    { token: o.token, authScheme: o.authScheme, timeoutMs }
  )
  if (!init.ok) return null
  const sessionId = init.sessionId
  await mcpFetch(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token: o.token, sessionId, authScheme: o.authScheme, timeoutMs })
  const res = await mcpFetch(
    url,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } },
    { token: o.token, sessionId, authScheme: o.authScheme, timeoutMs }
  )
  if (!res.ok) return null
  const result = (res.result as { result?: { isError?: boolean; content?: { type?: string; text?: string }[] } })?.result
  if (!result || result.isError) return null
  const text = (result.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON: a short first line may still be a name — leave the shaping to the caller.
    const first = text.split('\n')[0].trim()
    return first && first.length <= 80 ? { name: first } : null
  }
}

// ── The executor ─────────────────────────────────────────────────────────────

export interface IdentityRungs {
  /** The catalog `profile` spec for this service (absent = generic rungs only). */
  spec?: ProviderProfileSpec
  /** oidc rung, free and local: claims already in hand (the grant's id_token). */
  localClaims?: () => AccountProfile | null
  /** rest rung: an authorized GET returning parsed JSON (the caller binds the
   *  credential — token material never enters this module). Null = unreachable. */
  restFetch?: (url: string) => Promise<unknown | null>
  /** tool rung: the server's own tools/list names, and a bound caller. */
  toolNames?: readonly string[]
  callTool?: (name: string) => Promise<unknown | null>
  _testBreakAllowlist?: boolean
}

/**
 * Resolve "as WHO?" as well as the service possibly can — first rung with a real
 * answer wins, blanks fall through, nothing throws. Null means the card renders the
 * honest fallback line, never a guess.
 */
export async function resolveIdentityProfile(r: IdentityRungs): Promise<{ profile: AccountProfile; source: AccountSource } | null> {
  // 1 — oidc, from claims already in hand. Free, so always first where present.
  try {
    const local = r.localClaims?.() ?? null
    if (local) return { profile: local, source: 'oidc' }
  } catch {
    /* a malformed token names nobody */
  }

  // 2 — the catalog's identity endpoint. `oidc` specs that name a userinfo URL ride
  //     the same fetch and keep their honest source label.
  const spec = r.spec
  if (spec && spec.url && (spec.via === 'rest' || spec.via === 'oidc') && r.restFetch) {
    try {
      const body = await r.restFetch(spec.url)
      const profile = body == null ? null : (readProfilePaths(body, spec.paths) ?? profileFromLoose(body))
      if (profile) return { profile, source: spec.via === 'oidc' ? 'oidc' : 'rest' }
    } catch {
      /* unreachable or malformed — the next rung may still answer */
    }
  }

  // 3 — the whoami tool, behind its gate.
  if (r.callTool && r.toolNames?.length) {
    const name = whoamiToolPick(r.toolNames, spec?.via === 'tool' ? spec.tool : undefined, {
      _testBreakAllowlist: r._testBreakAllowlist
    })
    if (name) {
      try {
        const body = await r.callTool(name)
        const profile = body == null ? null : ((spec?.via === 'tool' ? readProfilePaths(body, spec.paths) : null) ?? profileFromLoose(body))
        if (profile) return { profile, source: 'tool' }
      } catch {
        /* the tool refused or rambled — a blank, not an error */
      }
    }
  }
  return null
}
