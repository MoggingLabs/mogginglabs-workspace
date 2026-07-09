import type { AgentProfile, PlanUsage, UsageAdapter, UsageCadence } from '@contracts'
import { USAGE_CADENCE_MS, findProvider } from '@contracts'
import { resolveHome } from './homes'

import { USAGE_PROVIDERS } from '@contracts'
import { CLI_STORE_READERS, readCodex } from './classes/cli-store'
import { fetchApiKeyUsage, type ApiKeyDeps } from './classes/api-key'
import { fetchVertex, fetchBedrock } from './classes/cloud-cli'
import { fetchWebSessionUsage, type WebSessionDeps } from './classes/web-session'
import { claudeAdapter } from './claude-adapter'
import { appendHistory } from './history'

export { fakeAdapter, setFakeMode } from './fake-adapter'
export { claudeAdapter } from './claude-adapter'
export { resolveHome } from './homes'
export { computePace, formatVerdict, formatPaceDelta, formatPaceTime, formatReset, formatRisk, runOutRisk, PACE_SEVERITY, type PaceOptions } from './pace'
export { PACE_GOLDENS } from './pace-fixtures'
export { CLI_STORE_READERS, readCodex } from './classes/cli-store'
export { API_KEY_SPECS, API_KEY_PENDING, fetchApiKeyUsage } from './classes/api-key'
export { fetchVertex, fetchBedrock } from './classes/cloud-cli'
export { fetchWebSessionUsage, fixtureCookieBackend, realCookieBackend, type WebSessionDeps, type CookieStoreBackend } from './classes/web-session'
export { scanCost, costLogDir, costLogDirs, priceFor, MODEL_PRICES, CACHE_READ_X, CACHE_WRITE_5M_X, CACHE_WRITE_1H_X, COST_LOG_SUBDIR, type CostScanOptions, type ModelPrice } from './cost'
export { appendHistory, readHistory, HISTORY_MAX, type HistoryKv } from './history'
export { createStatusService, normalizeStatusBody, STATUS_CADENCE_MS, type StatusService, type StatusServiceDeps, type StatusFetcher, type StatusProviderRow } from './status'
export { evaluateThresholds, suggestFailover, type ThresholdKv } from './thresholds'

/** Build the REAL adapters from the catalog (Phase-7/04): one per cli-store
 *  row that has a reader. Claude delegates to the shipped 7/01 adapter (already
 *  verified); the rest wrap their reader — detect is lenient (the reader
 *  produces the precise unconfigured/error reason). api-key/cloud-cli/
 *  web-session classes join in 7/05–06. */
export function buildRealAdapters(keys: ApiKeyDeps, web: WebSessionDeps): UsageAdapter[] {
  // All real adapters are perProfile (7/09): one home/lane per call — the
  // seam fans a provider out across its profiles. The FAKE adapter is not:
  // its fixture set models a full fan-out already.
  const out: UsageAdapter[] = []
  for (const def of USAGE_PROVIDERS) {
    if (def.klass === 'cli-store') {
      if (def.id === 'claude') {
        out.push({ ...claudeAdapter, perProfile: true })
        continue
      }
      const reader = CLI_STORE_READERS[def.id]
      if (!reader) continue
      out.push({
        id: def.id,
        perProfile: true,
        detect: async () => ({ ok: true }),
        fetch: async (home, profileId, signal) => [await reader(home, profileId, signal)]
      })
    } else if (def.klass === 'api-key') {
      // Key resolved per request by the INJECTED ADR-0007.a store; the key
      // exists only inside the class's fetch scope.
      out.push({
        id: def.id,
        perProfile: true,
        detect: async () => ({ ok: true }),
        fetch: async (_home, profileId, signal) => [await fetchApiKeyUsage(def.id, profileId, signal, keys)]
      })
    } else if (def.klass === 'cloud-cli') {
      const fetcher = def.id === 'vertex' ? fetchVertex : def.id === 'bedrock' ? fetchBedrock : null
      if (!fetcher) continue
      out.push({
        id: def.id,
        perProfile: true,
        detect: async () => ({ ok: true }),
        fetch: async (_home, profileId) => [await fetcher(profileId)]
      })
    } else if (def.klass === 'web-session') {
      out.push({
        id: def.id,
        perProfile: true,
        detect: async () => ({ ok: true }),
        fetch: async (_home, profileId, signal) => [await fetchWebSessionUsage(def, profileId, signal, web)]
      })
    } else if (def.klass === 'local') {
      // No auth by definition (loopback probe). Honest-pending until the
      // probe is dev-verified against a real local install.
      out.push({
        id: def.id,
        perProfile: true,
        detect: async () => ({ ok: true }),
        fetch: async (_home, profileId) => [
          {
            providerId: def.id,
            profileId,
            planLabel: '—',
            windows: [],
            fetchedAt: Date.now(),
            health: 'unconfigured',
            reason: `${def.label} probe is not wired yet — the row reserves the local class`
          }
        ]
      })
    }
  }
  return out
}

// The usage seam (Phase-7/01, ADR 0007): adapter registry + a polite poller.
// Electron-free — main injects the window-visibility signal, the KV, the
// profile list, and the change sink. Stale is a FIRST-CLASS state: on error
// the last good snapshot is re-served (dimmed by the UI), never dropped.
// Backoff is jittered exponential, capped — an erroring provider dims, it is
// never hammered.

export interface UsageServiceDeps {
  adapters: UsageAdapter[]
  /** Phase-4 profiles (pointer sets). Order 0 = the active/default lane. */
  profiles(): AgentProfile[]
  kv: { get(key: string): string | null; set(key: string, value: string): void }
  /** Pushed whenever the snapshot changes (IPC fan-out lives in main). */
  onChange(plans: PlanUsage[]): void
  /** Injected clock (IMPLEMENTATION.md rule — smokes pin time). */
  now?: () => number
  /** Base cadence override in ms (smoke uses a short one); presets otherwise. */
  cadenceMsOverride?: number
}

interface ProviderState {
  lastGood: PlanUsage[] | null
  lastAttempt: number
  consecutiveErrors: number
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  fetches: number
  errors: number
  lastDelayMs: number
}

const BACKOFF_CAP_MS = 30 * 60_000

export interface UsageService {
  list(): PlanUsage[]
  refresh(providerId?: string): void
  setVisible(visible: boolean): void
  stop(): void
  debug(): {
    visible: boolean
    providers: Record<string, { fetches: number; errors: number; lastDelayMs: number; hasLastGood: boolean }>
  }
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? Date.now
  const state = new Map<string, ProviderState>()
  let visible = true
  let stopped = false

  const st = (id: string): ProviderState => {
    let s = state.get(id)
    if (!s) {
      s = { lastGood: null, lastAttempt: 0, consecutiveErrors: 0, timer: null, inFlight: false, fetches: 0, errors: 0, lastDelayMs: 0 }
      state.set(id, s)
    }
    return s
  }

  /** Per-provider enable flag. Defaults by CLASS: cli-store (cheap local
   *  reads) and unknown/test ids are ON; api-key/cloud-cli/web-session are
   *  OFF until the user configures them (a saved key flips them on) — a real
   *  session must not poll 20 unconfigured endpoints into the popover. */
  const isEnabled = (id: string): boolean => {
    const v = deps.kv.get(`usage.enabled.${id}`)
    if (v === '0') return false
    if (v === '1') return true
    const klass = findProvider(id)?.klass
    return klass === undefined || klass === 'cli-store' || klass === 'local'
  }

  const cadenceMs = (id: string): number | null => {
    if (deps.cadenceMsOverride) return deps.cadenceMsOverride
    const preset = (deps.kv.get(`usage.cadence.${id}`) ?? '5m') as UsageCadence
    if (preset === 'manual') return null
    return USAGE_CADENCE_MS[preset] ?? USAGE_CADENCE_MS['5m']
  }

  const snapshot = (): PlanUsage[] => {
    const all: PlanUsage[] = []
    for (const a of deps.adapters) {
      if (!isEnabled(a.id)) continue // disabled providers vanish from the glance
      const s = state.get(a.id)
      if (s?.lastGood) all.push(...s.lastGood)
    }
    return all
  }

  const emit = (): void => deps.onChange(snapshot())

  const schedule = (a: UsageAdapter, delayMs: number): void => {
    const s = st(a.id)
    if (s.timer) clearTimeout(s.timer)
    if (stopped || !visible) return
    // ±10% jitter so N providers never align into a thundering herd.
    const jittered = Math.round(delayMs * (0.9 + Math.random() * 0.2))
    s.lastDelayMs = jittered
    s.timer = setTimeout(() => void poll(a), jittered)
  }

  const poll = async (a: UsageAdapter): Promise<void> => {
    const s = st(a.id)
    if (s.inFlight || stopped || !visible || !isEnabled(a.id)) return
    s.inFlight = true
    s.lastAttempt = now()
    s.fetches++
    // 7/09 fan-out: a perProfile adapter reads EVERY profile lane — three
    // profiles, three plan tiles. Others read the active lane only (the FAKE
    // adapter's fixture set already models a fan-out). Failure is PER LANE:
    // one capped profile dims stale while its siblings stay fresh.
    const forProvider = deps
      .profiles()
      .filter((p) => p.provider === a.id)
      .sort((x, y) => x.order - y.order)
    const lanes: (AgentProfile | null)[] =
      a.perProfile && forProvider.length > 0 ? forProvider : [forProvider[0] ?? null]
    const collected: PlanUsage[] = []
    let anyError = false
    for (const profile of lanes) {
      const profileId = profile?.id ?? 'default'
      const home = resolveHome(a.id, profile)
      const ctl = new AbortController()
      const timeout = setTimeout(() => ctl.abort(), 10_000)
      try {
        const detect = await a.detect(home)
        if (!detect.ok) {
          collected.push({
            providerId: a.id,
            profileId,
            planLabel: '—',
            windows: [],
            fetchedAt: now(),
            health: 'unconfigured',
            reason: detect.reason ?? 'not configured'
          })
        } else {
          const plans = await a.fetch(home, profileId, ctl.signal)
          collected.push(
            ...plans.map((p) => ({ ...p, windows: p.windows.map((w) => ({ ...w, usedPct: Math.max(0, Math.min(100, w.usedPct)) })) }))
          )
        }
      } catch (e) {
        anyError = true
        const reason = e instanceof Error ? e.message : 'usage fetch failed'
        // Stale is a state, not an error: re-serve this lane's last good
        // data, dimmed (single-lane adapters re-serve their whole set).
        const prev = (s.lastGood ?? []).filter(
          (p) => (p.health === 'fresh' || p.health === 'stale') && (!a.perProfile || p.profileId === profileId)
        )
        if (prev.length) collected.push(...prev.map((p) => ({ ...p, health: 'stale' as const, reason })))
        else
          collected.push({ providerId: a.id, profileId, planLabel: '—', windows: [], fetchedAt: now(), health: 'error', reason })
      } finally {
        clearTimeout(timeout)
      }
    }
    s.lastGood = collected
    if (anyError) {
      s.errors++
      s.consecutiveErrors++
    } else {
      s.consecutiveErrors = 0
    }
    // 7/07: ring each GOOD sample per (provider, window). Fresh only —
    // a stale re-serve is old data, not a new point.
    for (const p of collected) {
      if (p.health !== 'fresh') continue
      for (const w of p.windows) appendHistory(deps.kv, p.providerId, w.label, w.usedPct)
    }
    s.inFlight = false
    emit()
    const base = cadenceMs(a.id)
    if (base !== null) {
      // Jittered exponential backoff on consecutive errors, capped — never hammer.
      const next = s.consecutiveErrors > 0 ? Math.min(base * 2 ** s.consecutiveErrors, BACKOFF_CAP_MS) : base
      schedule(a, next)
    }
  }

  for (const a of deps.adapters) {
    const base = cadenceMs(a.id)
    if (base !== null) schedule(a, Math.min(base, 1500)) // first read soon after boot
  }

  return {
    list: snapshot,
    refresh(providerId) {
      for (const a of deps.adapters) {
        if (providerId && a.id !== providerId) continue
        void poll(a)
      }
    },
    setVisible(v) {
      if (v === visible) return
      visible = v
      for (const a of deps.adapters) {
        const s = st(a.id)
        if (!v) {
          // Hidden window = no polling at all (the poller PAUSES, not slows).
          if (s.timer) clearTimeout(s.timer)
          s.timer = null
        } else {
          const base = cadenceMs(a.id)
          if (base !== null) {
            const overdue = now() - s.lastAttempt >= base
            schedule(a, overdue ? 200 : base)
          }
        }
      }
    },
    stop() {
      stopped = true
      for (const s of state.values()) {
        if (s.timer) clearTimeout(s.timer)
        s.timer = null
      }
    },
    debug() {
      const providers: Record<string, { fetches: number; errors: number; lastDelayMs: number; hasLastGood: boolean }> = {}
      for (const a of deps.adapters) {
        const s = st(a.id)
        providers[a.id] = { fetches: s.fetches, errors: s.errors, lastDelayMs: s.lastDelayMs, hasLastGood: !!s.lastGood }
      }
      return { visible, providers }
    }
  }
}
