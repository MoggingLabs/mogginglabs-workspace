// The credential core (ADR 0020, phase-tools/02) — pure, Electron-free, and the
// only two behaviors in the app allowed to touch a raw token response or decide
// when a refresh runs:
//
//   · normalizeTokenResponse — ONE seam turning any provider's token response
//     (JSON or form-encoded, rotating or not, GitHub-quirked or standard) into
//     the CanonicalCredential shape, at the moment of exchange/refresh;
//   · RefreshCoordinator — Nango-grade refresh discipline: per-connection lock,
//     freshness margin, failure cooldown, and re-check-after-lock, so concurrent
//     demand (proxy call + heartbeat + manual Check) can never double-refresh a
//     rotating grant (the OAuth 2.1 race ADR 0014 §refresh predicted).
//
// The TOOLCRED gate (scripts/toolcred-pure-smoke.ts) bites both against a fixture
// AS, including mutation-red proofs that the lock and the seam are load-bearing.

import {
  REFRESH_FAILURE_COOLDOWN_MS,
  REFRESH_MARGIN_MS,
  credentialFresh,
  type CanonicalCredential
} from '@contracts'

// ── Normalization at exchange ─────────────────────────────────────────────────

export interface NormalizeQuirks {
  /** Seconds subtracted from `expires_in` when computing expiresAt (catalog
   *  method `quirks.tokenExpirationBuffer`). */
  tokenExpirationBuffer?: number
}

export type NormalizeResult =
  | { ok: true; credential: CanonicalCredential; raw: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * Turn a raw token response BODY into the canonical credential. Accepts both
 * shapes in the wild: JSON (the spec) and form-encoded (GitHub without an
 * `Accept: application/json` header — and any proxy that strips one). `raw` is
 * returned ONLY for connect-time account discovery (OIDC id_token riders); it is
 * never stored — the vault write strips it at its own choke point.
 */
export function normalizeTokenResponse(
  bodyText: string,
  contentType: string | null | undefined,
  o: { quirks?: NormalizeQuirks; now?: number; method?: string } = {}
): NormalizeResult {
  const now = o.now ?? Date.now()
  let raw: Record<string, unknown> | null = null
  const looksForm = !!contentType && contentType.includes('application/x-www-form-urlencoded')
  if (!looksForm) {
    try {
      const parsed = JSON.parse(bodyText) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
    } catch {
      raw = null
    }
  }
  if (!raw) {
    // Form-encoded (or a JSON parse that failed on a body that IS form-shaped).
    if (/(^|&)[A-Za-z0-9_]+=/.test(bodyText.trim())) {
      raw = Object.fromEntries(new URLSearchParams(bodyText.trim()))
    } else {
      return { ok: false, reason: 'The provider returned a token response we could not parse.' }
    }
  }
  const str = (k: string): string | undefined => {
    const v = raw![k]
    return typeof v === 'string' && v.length ? v : undefined
  }
  const num = (k: string): number | undefined => {
    const v = raw![k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return undefined
  }
  const accessToken = str('access_token')
  if (!accessToken) return { ok: false, reason: 'The provider returned no access token.' }
  const bufferMs = Math.max(0, o.quirks?.tokenExpirationBuffer ?? 0) * 1000
  const expiresIn = num('expires_in')
  const refreshExpiresIn = num('refresh_token_expires_in')
  const scope = str('scope')
  const credential: CanonicalCredential = {
    accessToken,
    tokenType: str('token_type') ?? 'Bearer',
    obtainedAt: now,
    ...(expiresIn != null ? { expiresAt: now + expiresIn * 1000 - bufferMs } : {}),
    ...(str('refresh_token') ? { refreshToken: str('refresh_token') } : {}),
    ...(refreshExpiresIn != null ? { refreshTokenExpiresAt: now + refreshExpiresIn * 1000 } : {}),
    ...(scope ? { scopes: scope.split(/[\s,]+/).filter(Boolean) } : {}),
    ...(o.method ? { method: o.method } : {})
  }
  return { ok: true, credential, raw }
}

/** The rotation-merge rule on the canonical shape: a refresh response WITHOUT a
 *  new refresh token keeps the previous one (persisting undefined over it
 *  strands the grant); a rotated one wins. Same law as mergeRefreshedTokens —
 *  restated here because the coordinator merges canonical credentials. */
export const mergeRefreshedCredential = (
  prev: Pick<CanonicalCredential, 'refreshToken' | 'refreshTokenExpiresAt'>,
  next: CanonicalCredential
): CanonicalCredential => ({
  ...next,
  refreshToken: next.refreshToken ?? prev.refreshToken,
  refreshTokenExpiresAt: next.refreshToken ? next.refreshTokenExpiresAt : (next.refreshTokenExpiresAt ?? prev.refreshTokenExpiresAt)
})

// ── Refresh discipline ────────────────────────────────────────────────────────

export interface RefreshDeps<C extends { expiresAt?: number; accessToken: string }> {
  /** Re-read the stored credential NOW — called again after the lock is won
   *  (double-checked): the winner may already have refreshed while we waited. */
  load(): C | null
  /** Perform the actual refresh trip. */
  refresh(current: C): Promise<{ ok: true; credential: C } | { ok: false; reason: string }>
  /** Persist the merged result. False = the vault refused (fatal for this run). */
  store(next: C): boolean
  now?: () => number
}

export type RefreshOutcome<C> =
  | { ok: true; credential: C; refreshed: boolean }
  | { ok: false; reason: string; cooled?: boolean }

/**
 * Per-connection refresh serialization + margin + cooldown. ONE instance per
 * process; every caller that needs a live token routes through `current()`.
 */
export class RefreshCoordinator {
  private inflight = new Map<string, Promise<unknown>>()
  private cooldownUntil = new Map<string, number>()
  constructor(
    private opts: {
      marginMs?: number
      cooldownMs?: number
      /** TEST-ONLY (the TOOLCRED mutation-red): skip the lock so the gate can
       *  prove its concurrent-demand assertion catches a lockless coordinator. */
      _testDisableLock?: boolean
    } = {}
  ) {}

  /** Clear a connection's cooldown — a user-initiated Reconnect always may try. */
  reset(id: string): void {
    this.cooldownUntil.delete(id)
  }

  async current<C extends { expiresAt?: number; accessToken: string }>(id: string, deps: RefreshDeps<C>): Promise<RefreshOutcome<C>> {
    const now = deps.now ?? Date.now
    const margin = this.opts.marginMs ?? REFRESH_MARGIN_MS
    const fresh = (c: C): boolean => !c.expiresAt || c.expiresAt - now() > margin
    const first = deps.load()
    if (!first) return { ok: false, reason: 'no credential stored' }
    if (fresh(first)) return { ok: true, credential: first, refreshed: false }

    const until = this.cooldownUntil.get(id) ?? 0
    if (until > now()) {
      return { ok: false, reason: 'refresh recently refused — waiting before retrying', cooled: true }
    }

    if (!this.opts._testDisableLock) {
      const waiting = this.inflight.get(id)
      if (waiting) {
        await waiting.catch(() => undefined)
        // RE-CHECK AFTER LOCK: the winner refreshed (or failed) — re-read rather
        // than trust anything captured before the wait.
        const after = deps.load()
        if (after && fresh(after)) return { ok: true, credential: after, refreshed: false }
        const cooled = (this.cooldownUntil.get(id) ?? 0) > now()
        if (cooled) return { ok: false, reason: 'refresh recently refused — waiting before retrying', cooled: true }
        // Fall through: the winner's outcome didn't settle it — take the lock ourselves.
      }
    }

    const run = (async (): Promise<RefreshOutcome<C>> => {
      // Double-checked after acquiring: whoever held the lock before us may have
      // stored fresh credentials between our first read and now.
      const current = deps.load()
      if (!current) return { ok: false, reason: 'no credential stored' }
      if (fresh(current)) return { ok: true, credential: current, refreshed: false }
      const next = await deps.refresh(current)
      if (!next.ok) {
        this.cooldownUntil.set(id, now() + (this.opts.cooldownMs ?? REFRESH_FAILURE_COOLDOWN_MS))
        return { ok: false, reason: next.reason }
      }
      this.cooldownUntil.delete(id)
      if (!deps.store(next.credential)) return { ok: false, reason: 'the OS keychain would not hold the renewed credential' }
      return { ok: true, credential: next.credential, refreshed: true }
    })()
    if (!this.opts._testDisableLock) {
      this.inflight.set(id, run)
      void run.finally(() => {
        if (this.inflight.get(id) === run) this.inflight.delete(id)
      })
    }
    return run
  }
}

export { credentialFresh, REFRESH_MARGIN_MS, REFRESH_FAILURE_COOLDOWN_MS }

// ── Prove-before-save: the catalog verification probe ────────────────────────
// Activepieces' law, catalog-driven: a pasted key must PROVE itself against the
// provider's own declared endpoint before anything saves. The MCP-level probe
// (initialize + tools/list) remains the final proof for MCP services; this REST
// probe exists because a wrong key deserves the provider's own 401 in seconds,
// not an MCP handshake's worth of round trips — and because some services verify
// on an endpoint the MCP server doesn't serve.

export interface VerificationSpec {
  method: 'GET' | 'POST'
  endpoint: string
  headers?: Readonly<Record<string, string>>
}

export async function runVerificationProbe(
  spec: VerificationSpec,
  key: string,
  o: { authScheme?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<{ ok: true } | { ok: false; unauthorized?: boolean; reason: string }> {
  const doFetch = o.fetchFn ?? fetch
  let res: Response
  try {
    res = await doFetch(spec.endpoint, {
      method: spec.method,
      headers: {
        authorization: `${o.authScheme ?? 'Bearer'} ${key}`,
        ...(spec.headers ?? {})
      },
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000)
    })
  } catch (e) {
    return { ok: false, reason: `Could not reach the verification endpoint: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, unauthorized: true, reason: 'That key was refused by the service.' }
  if (!res.ok) return { ok: false, reason: `The verification endpoint answered ${res.status}.` }
  return { ok: true }
}

// ── Catalog-driven retry (Nango's proxy metadata) ────────────────────────────

export interface RetrySpec {
  atHeader?: string
  remainingHeader?: string
  errorCodes?: readonly string[]
}

/** Does `status` match the spec's retryable codes ('5xx' families allowed)? */
export function retryableStatus(status: number, spec: RetrySpec | undefined): boolean {
  const codes = spec?.errorCodes ?? ['429', '5xx']
  return codes.some((c) => (/^\dxx$/i.test(c) ? Math.floor(status / 100) === Number(c[0]) : Number(c) === status))
}

/** How long to wait before the retry, from the provider's own headers when the
 *  catalog names them (epoch-seconds reset stamps and delta-seconds both occur),
 *  else a small backoff. Capped — an agent call must never hang minutes. */
export function retryDelayMs(
  headers: { get(name: string): string | null },
  spec: RetrySpec | undefined,
  attempt: number,
  now: number,
  capMs = 5000
): number {
  const fallback = Math.min(capMs, 400 * 2 ** attempt)
  const name = spec?.atHeader
  if (!name) return fallback
  const v = headers.get(name)
  if (!v || !Number.isFinite(Number(v))) return fallback
  const n = Number(v)
  // Epoch stamp (x-ratelimit-reset) vs delta seconds (retry-after): anything that
  // reads as a past-or-tiny epoch is a delta.
  const ms = n > now / 1000 - 10 && n > 1e9 ? n * 1000 - now : n * 1000
  return Math.max(0, Math.min(capMs, ms))
}
