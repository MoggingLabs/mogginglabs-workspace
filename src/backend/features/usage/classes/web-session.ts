import type { PlanUsage, UsageProviderDef } from '@contracts'
import { isSensitiveOrigin } from '@contracts'

// The `web-session` class (Phase-7/06, ADR 0007.b): the sharpest tier. Two
// sources behind one interface —
//   PASTE      the user pastes a cookie/token once; stored via 0007.a's
//              write-only keychain path; decrypted backend-side for the one
//              request. THE DEFAULT.
//   STORE-READ per-provider OPT-IN, default OFF: decrypt THAT provider's cookie
//              for ITS origin via the platform keychain key — one cookie, one
//              request, dropped. Never a crawl, never a write, never
//              agent-facing (agent-web Branch B stays parked).
//
// The cookie value lives ONLY inside `fetch`'s scope and never enters a
// PlanUsage (grep-proven). A sensitive origin (bank/mail/gov) is refused even
// if a row named one. Endpoint parses for these providers are honest-pending
// (no accounts to dev-verify) — the SECURITY surface (paste storage, consent
// gating, no-leak) is what ships fully proven here.

export interface WebSessionDeps {
  /** Pasted cookie/token for this provider (write-only 0007.a store). Null =
   *  none pasted. */
  pasteValue(providerId: string): Promise<string | null> | string | null
  /** Is automatic browser store-read opted in for this provider? Default OFF. */
  storeReadEnabled(providerId: string): boolean
  /** Read ONE cookie for (origin, name) from the browser store. Called ONLY
   *  when storeReadEnabled is true — the seam must never touch the store
   *  otherwise. Returns null when absent/undecryptable. */
  readCookie(origin: string, cookieName: string): Promise<string | null> | string | null
  /** The ONE bounded authenticated GET a spec makes. Injectable so the smoke
   *  drives the real parse path with a fixture body and ZERO network; absent =
   *  real fetch (real sessions only). */
  http?(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; body: unknown }>
}

const labeled = (id: string, profileId: string, health: PlanUsage['health'], reason: string): PlanUsage => ({
  providerId: id,
  profileId,
  planLabel: '—',
  windows: [],
  fetchedAt: Date.now(),
  health,
  reason
})

/** Resolve the session value for a web-session provider WITHOUT leaking it.
 *  Order: paste first (always allowed), then store-read (only if opted in). */
async function resolveSession(def: UsageProviderDef, deps: WebSessionDeps): Promise<{ value: string | null; source: 'paste' | 'store' | 'none' }> {
  const pasted = await deps.pasteValue(def.id)
  if (pasted) return { value: pasted, source: 'paste' }
  // Store-read is gated: if OFF, the store is NEVER touched.
  if (deps.storeReadEnabled(def.id) && def.origin && def.cookieName) {
    if (isSensitiveOrigin(def.origin)) return { value: null, source: 'none' } // refused, never read
    const cookie = await deps.readCookie(def.origin, def.cookieName)
    if (cookie) return { value: cookie, source: 'store' }
  }
  return { value: null, source: 'none' }
}

// ── Endpoint specs (phase-11): a web-session provider with a spec makes ONE
// bounded authenticated GET and returns a REAL plan — the audit found the
// class returning 'unconfigured' on its own success path, which excluded
// every web-session row from alerts no matter how correctly the user
// configured it. Rows without a spec keep the honest pending return.

export interface WebSessionSpec {
  /** Build the ONE request. The session value rides a Cookie header only. */
  request(cookieHeader: string): { url: string; headers: Record<string, string> }
  /** Normalize the 200 body. Throw Error(reason) on shape drift. */
  parse(body: unknown, now: number, profileId: string): PlanUsage
}

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

/** A pasted value may be the bare cookie VALUE or a whole `Cookie:` header —
 *  users copy both. A '=' means header-shaped; else pair it with the row's
 *  cookie name. */
function cookieHeaderFor(def: UsageProviderDef, value: string): string {
  return value.includes('=') ? value : `${def.cookieName ?? 'session'}=${value}`
}

export const WEB_SESSION_SPECS: Record<string, WebSessionSpec> = {
  // Cursor: GET /api/usage-summary (shape ported from steipete/CodexBar's
  // dev-verified CursorUsageSummary, 2026-07-15). Cents-based blocks; the
  // plan lane carries totalPercentUsed; on-demand dollars ride `spend`.
  cursor: {
    request: (cookieHeader) => ({
      url: 'https://cursor.com/api/usage-summary',
      headers: { Cookie: cookieHeader, Accept: 'application/json' }
    }),
    parse: (body, now, profileId) => {
      const b = body as {
        billingCycleEnd?: string
        membershipType?: string
        individualUsage?: {
          plan?: { used?: number; limit?: number; totalPercentUsed?: number }
          onDemand?: { enabled?: boolean; used?: number; limit?: number }
        }
      } | null
      const plan = b?.individualUsage?.plan
      if (!b || (!plan && !b.individualUsage?.onDemand)) throw new Error('Cursor usage-summary shape changed — adapter needs a look')
      const pct =
        typeof plan?.totalPercentUsed === 'number'
          ? plan.totalPercentUsed
          : typeof plan?.used === 'number' && typeof plan?.limit === 'number' && plan.limit > 0
            ? (plan.used / plan.limit) * 100
            : null
      const windows =
        pct === null
          ? []
          : [
              {
                label: 'Plan',
                usedPct: clampPct(pct),
                windowMs: 30 * 86_400_000,
                ...(b.billingCycleEnd ? { resetsAt: b.billingCycleEnd } : {})
              }
            ]
      const od = b.individualUsage?.onDemand
      const spend =
        od?.enabled && typeof od.used === 'number'
          ? {
              amount: Math.round(od.used) / 100,
              currency: 'USD',
              ...(typeof od.limit === 'number' && od.limit > 0 ? { limit: Math.round(od.limit) / 100 } : {})
            }
          : undefined
      return {
        providerId: 'cursor',
        profileId,
        planLabel: b.membershipType ? `Cursor (${b.membershipType})` : 'Cursor',
        windows,
        ...(spend ? { spend } : {}),
        fetchedAt: now,
        health: 'fresh'
      }
    }
  }
}

export async function fetchWebSessionUsage(def: UsageProviderDef, profileId: string, signal: AbortSignal, deps: WebSessionDeps): Promise<PlanUsage> {
  if (def.origin && isSensitiveOrigin(def.origin)) {
    return labeled(def.id, profileId, 'unconfigured', 'this origin is on the sensitive blocklist — usage is not read here (ADR 0007.b)')
  }
  const { value, source } = await resolveSession(def, deps)
  if (!value) {
    const hint = deps.storeReadEnabled(def.id)
      ? 'paste your session cookie in Settings § Usage (browser read found nothing)'
      : 'paste your session cookie in Settings § Usage (or opt in to reading your browser session)'
    return labeled(def.id, profileId, 'unconfigured', hint)
  }
  const spec = WEB_SESSION_SPECS[def.id]
  if (spec) {
    // The cookie lives only inside this scope; it never rides the shape.
    const { url, headers } = spec.request(cookieHeaderFor(def, value))
    const http =
      deps.http ??
      (async (u: string, h: Record<string, string>, s: AbortSignal): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(u, { signal: s, headers: h, redirect: 'manual' })
        return { status: res.status, body: res.ok ? await res.json() : null }
      })
    const res = await http(url, headers, signal)
    if (res.status === 401 || res.status === 403 || res.status >= 300)
      throw new Error('session cookie rejected — paste a fresh one in Settings § Usage')
    if (res.status !== 200) throw new Error(`usage endpoint answered ${res.status}`)
    return spec.parse(res.body, Date.now(), profileId)
  }
  // No spec yet: the session is confirmed PRESENT and its value is dropped —
  // it never rides the returned shape.
  void value
  return {
    providerId: def.id,
    profileId,
    planLabel: def.label,
    windows: [],
    fetchedAt: Date.now(),
    health: 'unconfigured',
    reason: `session found (via ${source}) — usage endpoint parse lands when a real login is dev-verified`
  }
}

// ── Cookie-store locations (the per-OS path table). The REAL store-read
//    decrypt (Chrome/Edge/Brave Safe-Storage key via the OS keychain + AES-GCM
//    over the cookie SQLite) is a per-OS job wired when dev-verified against a
//    real browser; until then the real backend degrades honestly and paste is
//    the headline. The FIXTURE backend (below) is what the smoke drives. ──────

export interface CookieStoreBackend {
  read(origin: string, cookieName: string): Promise<string | null>
}

/** Fixture backend: a JSON file `{ "<origin>": { "<cookie>": "<value>" } }`.
 *  Drives the smoke's store-read path with ZERO real browser access. */
export function fixtureCookieBackend(loadJson: () => Record<string, Record<string, string>> | null): CookieStoreBackend {
  return {
    read: async (origin, cookieName) => {
      const store = loadJson()
      return store?.[origin]?.[cookieName] ?? null
    }
  }
}

/** Real backend: honest-pending until the per-OS decrypt is dev-verified. It
 *  reports nothing rather than half-reading a store. */
export const realCookieBackend: CookieStoreBackend = {
  read: async () => null
}
