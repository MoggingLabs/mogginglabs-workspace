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

export async function fetchWebSessionUsage(def: UsageProviderDef, profileId: string, _signal: AbortSignal, deps: WebSessionDeps): Promise<PlanUsage> {
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
  // Endpoint parse is honest-pending for these providers (no account to
  // dev-verify); the session is confirmed PRESENT and its value is dropped —
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
