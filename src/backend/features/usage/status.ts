import type { ProviderStatus, ProviderStatusState } from '@contracts'

// The provider status feed (Phase-7/08): "they're down" is a different fact
// from "you're out". Polls the PUBLIC statusUrl of ENABLED providers only, on
// ONE shared jittered cadence (status changes slowly — default 5m), backoff
// per provider on error, paused when hidden — the usage poller's discipline
// on its own clock. Electron-free; the FETCHER is injected: a smoke world
// passes null (zero real endpoints, structurally) or a fixture. An
// unreachable/unparseable endpoint reads `unknown` — never an error surface.

export type StatusFetcher = (url: string, signal: AbortSignal) => Promise<string>

export interface StatusProviderRow {
  id: string
  statusUrl?: string
}

export interface StatusServiceDeps {
  /** Catalog rows (id + statusUrl). Rows without a statusUrl never poll. */
  providers(): StatusProviderRow[]
  /** The seam's enable rule — DISABLED providers are never polled. */
  isEnabled(id: string): boolean
  /** null = no endpoint may be touched at all (smoke worlds) — structural. */
  fetcher: StatusFetcher | null
  /** Pushed when any provider's state/note actually changes. */
  onChange(statuses: ProviderStatus[]): void
  now?: () => number
  cadenceMsOverride?: number
}

/** Status cadence — its own clock, slower is fine: incidents move in minutes. */
export const STATUS_CADENCE_MS = 5 * 60_000
const STATUS_BACKOFF_CAP_MS = 60 * 60_000
const FETCH_TIMEOUT_MS = 8_000

/** Normalize a public status body to the enum. Handles the statuspage.io
 *  summary shape (`status.indicator`) and generic up/down health JSON;
 *  anything else — junk, HTML, surprises — is `unknown`, never a throw. */
export function normalizeStatusBody(body: string): { state: ProviderStatusState; note?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { state: 'unknown' }
  }
  if (!parsed || typeof parsed !== 'object') return { state: 'unknown' }
  const rec = parsed as Record<string, unknown>
  const status = rec.status
  // statuspage.io: { status: { indicator: none|minor|major|critical, description } }
  if (status && typeof status === 'object') {
    const s = status as Record<string, unknown>
    const indicator = typeof s.indicator === 'string' ? s.indicator.toLowerCase() : ''
    const note = typeof s.description === 'string' && s.description ? s.description : undefined
    if (indicator === 'none') return { state: 'operational' }
    if (indicator === 'minor') return { state: 'degraded', note }
    if (indicator === 'major' || indicator === 'critical') return { state: 'outage', note }
    return { state: 'unknown' }
  }
  // generic up/down: { status: "ok" } and friends
  if (typeof status === 'string') {
    const s = status.toLowerCase()
    if (['ok', 'up', 'operational', 'online', 'healthy', 'pass'].includes(s)) return { state: 'operational' }
    if (['degraded', 'partial', 'minor', 'warning'].includes(s)) return { state: 'degraded', note: status }
    if (['down', 'outage', 'major', 'critical', 'fail', 'unhealthy'].includes(s)) return { state: 'outage', note: status }
    return { state: 'unknown' }
  }
  if (typeof rec.ok === 'boolean') return { state: rec.ok ? 'operational' : 'outage' }
  return { state: 'unknown' }
}

export interface StatusService {
  list(): ProviderStatus[]
  /** One immediate shared pass (awaitable — smokes pin on it). */
  refresh(): Promise<void>
  setVisible(visible: boolean): void
  stop(): void
  debug(): { visible: boolean; fetches: number; lastDelayMs: number; errors: Record<string, number> }
}

export function createStatusService(deps: StatusServiceDeps): StatusService {
  const now = deps.now ?? Date.now
  const cadence = deps.cadenceMsOverride ?? STATUS_CADENCE_MS
  const state = new Map<string, ProviderStatus>()
  const errors = new Map<string, number>()
  const backoffUntil = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let visible = true
  let stopped = false
  let ticking = false
  let fetches = 0
  let lastDelayMs = 0

  const eligible = (): { id: string; statusUrl: string }[] =>
    deps
      .providers()
      .filter((p): p is { id: string; statusUrl: string } => !!p.statusUrl && deps.isEnabled(p.id))

  const list = (): ProviderStatus[] => [...state.values()]

  const schedule = (delayMs: number): void => {
    if (timer) clearTimeout(timer)
    if (stopped || !visible) return
    // ±10% jitter — N providers on one pass still must not align across apps.
    const jittered = Math.round(delayMs * (0.9 + Math.random() * 0.2))
    lastDelayMs = jittered
    timer = setTimeout(() => void tick(), jittered)
  }

  /** ONE shared pass: every due enabled provider, SEQUENTIALLY — 50 providers
   *  must never mean 50 concurrent status hammers. */
  const tick = async (): Promise<void> => {
    if (ticking || stopped || !visible) return
    ticking = true
    let changed = false
    try {
      if (deps.fetcher) {
        const rows = eligible()
        for (const p of rows) {
          if ((backoffUntil.get(p.id) ?? 0) > now()) continue
          const ctl = new AbortController()
          const timeout = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
          let next: ProviderStatus
          try {
            fetches++
            const body = await deps.fetcher(p.statusUrl, ctl.signal)
            const n = normalizeStatusBody(body)
            next = { providerId: p.id, state: n.state, ...(n.note ? { note: n.note } : {}), checkedAt: now() }
            errors.delete(p.id)
            backoffUntil.delete(p.id)
          } catch {
            // Unreachable -> unknown + polite per-provider backoff. Never an
            // error state: an absent status page is not an incident.
            const e = (errors.get(p.id) ?? 0) + 1
            errors.set(p.id, e)
            backoffUntil.set(p.id, now() + Math.min(cadence * 2 ** e, STATUS_BACKOFF_CAP_MS))
            next = { providerId: p.id, state: 'unknown', checkedAt: now() }
          } finally {
            clearTimeout(timeout)
          }
          const prev = state.get(p.id)
          if (!prev || prev.state !== next.state || prev.note !== next.note) changed = true
          state.set(p.id, next)
        }
        // A provider disabled since its last check drops out of the feed.
        const ids = new Set(rows.map((p) => p.id))
        for (const id of [...state.keys()])
          if (!ids.has(id)) {
            state.delete(id)
            changed = true
          }
      }
    } finally {
      ticking = false
    }
    if (changed) deps.onChange(list())
    schedule(cadence)
  }

  schedule(Math.min(cadence, 2_000)) // first pass soon after boot

  return {
    list,
    refresh: () => tick(),
    setVisible(v) {
      if (v === visible) return
      visible = v
      if (!v) {
        // Hidden window = no status polling at all (pause, not slow).
        if (timer) clearTimeout(timer)
        timer = null
      } else schedule(500)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    debug() {
      return { visible, fetches, lastDelayMs, errors: Object.fromEntries(errors) }
    }
  }
}
