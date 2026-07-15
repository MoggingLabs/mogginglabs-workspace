import { app, ipcMain, type BrowserWindow } from 'electron'
import { UsageChannels, USAGE_CADENCES, USAGE_PROVIDERS, USAGE_ALERT_DEFAULTS, USAGE_DISPLAY_DEFAULTS, findProvider, type PlanUsage, type UsageCadence } from '@contracts'
import type { AgentProfile, PlanUsageView, PaceView, UsageConfig, UsageConfigPatch, CostScan, UsageAlert, UsageAlertConfig, UsageDisplayConfig } from '@contracts'
import {
  createUsageService,
  buildRealAdapters,
  realCookieBackend,
  computePace,
  formatVerdict,
  formatPaceDelta,
  formatRisk,
  formatReset,
  PACE_SEVERITY,
  resolveHome,
  scanCost,
  costLogDirs,
  readHistory,
  createStatusService,
  evaluateThresholds,
  COST_LOG_SUBDIR,
  type StatusService,
  type UsageService
} from '@backend/features/usage'
import { getSettingsStore } from './app-settings'
import { maybeFault } from './fault-port'
import { usageWorld } from './fixture-port'
import { keySlot, keySetPlaintext, keySetEnvRef, keyClear, resolveKey } from './usage-keys'

// App-wiring: usage meters (Phase-7/01+03, ADR 0007). Adapter pick is the
// zero-network guarantee: under a usage smoke (or the gallery) the registry
// holds ONLY the FAKE adapter; under any OTHER smoke it holds nothing; real
// adapters exist only in a real session. Main feeds the poller window
// visibility, fans snapshot changes out on one push channel, and — 7/03 —
// attaches the PACE VIEW here, so the ONE backend formatter produces every
// string the renderer shows. No token, path, or account id crosses this file.
//
// That pick used to be made HERE, by reading the environment — and it shipped
// (audit finding 41). MOGGING_USAGE / MOGGING_SETUSAGE / MOGGING_UXMILESTONE
// were live strings in out/main/index.js, which means a real, signed install,
// handed one environment variable, would have swapped the FAKE adapter in and
// shown a user FABRICATED usage and spend as if they were their own. The world
// now arrives through src/main/fixture-port.ts: null in production (real
// adapters, real status, real cost), non-null only in the dev/serve entry. The
// fakes are not in this module's graph any more — the guarantee is structural,
// not a branch.

let service: UsageService | null = null
let statusService: StatusService | null = null

/** Smoke hook: direct service access (main-side only). */
export function getUsageService(): UsageService | null {
  return service
}

/** Smoke/gallery hook: the 7/08 status feed (main-side only). */
export function getUsageStatusService(): StatusService | null {
  return statusService
}

// ── 7/11: the `mogging usage` verbs ride the EXISTING authed app endpoint
// (6/05b) as `usage.*` call names — no new listener, no daemon change (v3
// intact). These accessors are assigned by registerUsage; the endpoint
// dispatches here. Key material flows ONE way (set/clear) — there is no
// usage.getKey, by design, and no frame ever echoes a value.
let cliViews: (() => PlanUsageView[]) | null = null
let cliCost: ((providerId: string) => CostScan) | null = null
let cliProviders: (() => Record<string, unknown>[]) | null = null

export async function handleUsageCall(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; reason?: string } & Record<string, unknown>> {
  const provider = typeof args.provider === 'string' && args.provider ? args.provider : undefined
  if (!cliViews) return { ok: false, reason: 'usage not ready' }
  switch (name) {
    case 'usage.list':
      // The SAME enriched views the popover renders — one formatter, verbatim.
      return { ok: true, plans: cliViews() }
    case 'usage.providers':
      return { ok: true, providers: cliProviders?.() ?? [] }
    case 'usage.cost': {
      const ids = !provider || provider === 'all' ? Object.keys(COST_LOG_SUBDIR) : [provider]
      return { ok: true, scans: ids.map((id) => cliCost?.(id)).filter(Boolean) }
    }
    case 'usage.refresh':
      service?.refresh(provider)
      return { ok: true }
    case 'usage.setKey': {
      const value = typeof args.value === 'string' ? args.value : ''
      if (!provider || !value) return { ok: false, reason: 'bad request' }
      const out = keySetPlaintext(provider, value)
      if (out.ok) {
        getSettingsStore()?.setSetting(`usage.enabled.${provider}`, '1')
        service?.refresh(provider)
      }
      return out // ok/reason only — the plaintext is NEVER echoed (ADR 0007.a)
    }
    case 'usage.clearKey':
      if (!provider) return { ok: false, reason: 'bad request' }
      keyClear(provider)
      service?.refresh(provider)
      return { ok: true }
    default:
      return { ok: false, reason: 'unknown-tool' }
  }
}

/** Window length inferred from the label until 7/04's catalog carries
 *  explicit WindowSpecs. Unknown length -> no pace (never speculate). */
function windowMsFor(label: string): number | null {
  const l = label.toLowerCase()
  if (l.includes('(5h)') || l.includes('session')) return 5 * 3_600_000
  if (l.includes('week')) return 7 * 86_400_000
  if (l.includes('month')) return 30 * 86_400_000
  if (l.includes('day') || l.includes('daily')) return 86_400_000
  if (l.includes('hour')) return 3_600_000
  return null
}

/** The zone offset AT the instant being rendered. Sampling it "now" and applying
 *  it to a FUTURE moment — a reset, a projected run-out — prints the wall clock
 *  an hour wrong on the far side of a DST change: the formatters shift by
 *  whatever offset they are handed, and the offset is not the same all week. */
const tzAt = (atMs: number): number => -new Date(atMs).getTimezoneOffset()

const SEVERITY_RANK = { 'runs-out': 2, surplus: 1, 'on-pace': 0 } as const

/** Attach pace to EVERY paceable window (the session limit AND the weekly
 *  limit AND any model lane pace themselves — both forecasts, side by side),
 *  plus the worst window's pace at the plan level (the gauge/alerts read
 *  that one). Fresh/stale only — an error/unconfigured tile renders its age
 *  + reason, never a forecast. */
function toView(p: PlanUsage): PlanUsageView {
  if (p.health !== 'fresh' && p.health !== 'stale') return p
  const now = Date.now() // ONE clock for every window of the plan
  let best: PaceView | undefined
  let bestRank = -1
  const windows = p.windows.map((w) => {
    const windowMs = w.windowMs && w.windowMs > 0 ? w.windowMs : windowMsFor(w.label)
    if (!windowMs) return w
    const report = computePace(w, now, { windowMs, tzOffsetMinutes: tzAt(now) })
    if (!report) return w
    const view: PaceView = {
      verdict: report.verdict,
      // "runs out ~Thu 07:06" is a FUTURE wall clock — read the offset there.
      text: formatVerdict(report, w.label, tzAt(report.runOutAt ?? now)),
      deltaText: formatPaceDelta(report.paceDelta),
      severity: PACE_SEVERITY[report.verdict],
      elapsedPct: Math.round(report.elapsedPct),
      ...(report.runOutRiskPct !== undefined ? { riskText: formatRisk(report.runOutRiskPct) } : {})
    }
    const rank = SEVERITY_RANK[report.verdict]
    if (rank > bestRank) {
      bestRank = rank
      best = view
    }
    return { ...w, pace: view }
  })
  return best ? { ...p, windows, pace: best } : { ...p, windows }
}

export function registerUsage(getWin: () => BrowserWindow | null): void {
  // Null in the shipped app — always. Non-null ONLY under the dev/test entry, and then it is the
  // whole difference: the adapters, the poll cadence, the status feed, and the cost scan.
  const world = usageWorld()
  // web-session deps (ADR 0007.b): a pasted cookie rides the SAME write-only
  // store as a key; store-read is per-provider opt-in (default OFF) and only
  // then may the real cookie backend be touched.
  const webDeps = {
    pasteValue: (id: string) => resolveKey(id),
    storeReadEnabled: (id: string) => getSettingsStore()?.getSetting(`usage.webread.${id}`) === '1',
    readCookie: (origin: string, name: string) => realCookieBackend.read(origin, name)
  }
  const adapters = world ? world.adapters : buildRealAdapters({ resolveKey }, webDeps)
  const cadenceMsOverride = world?.cadenceMsOverride

  // ── 7/08: the status feed, on its own (slower) clock. FAKE-under-smoke is
  // structural: a usage-fixture world registers ONE fake row served by an
  // env-driven fixture body; any other smoke registers NO fetcher at all;
  // real PUBLIC endpoints (https, no auth, no cookies) exist only in a real
  // session. Enabled-only is the seam's own rule, re-checked per pass.
  const statusRows =
    world?.statusRows ?? USAGE_PROVIDERS.filter((p) => p.statusUrl).map((p) => ({ id: p.id, statusUrl: p.statusUrl }))
  // A harness world's fetcher may be null — that is the seam's own way of saying "no endpoint may
  // be touched at all", and it is why a non-usage gate reaches no network by construction.
  const statusFetcher = world
    ? world.statusFetcher
    : async (url: string, signal: AbortSignal): Promise<string> => {
        const res = await fetch(url, { signal, redirect: 'follow' })
        if (!res.ok) throw new Error(`http ${res.status}`)
        return res.text()
      }
  const statusEnabled = (id: string): boolean => {
    const v = getSettingsStore()?.getSetting(`usage.enabled.${id}`)
    if (v === '0') return false
    if (v === '1') return true
    const klass = findProvider(id)?.klass
    return klass === undefined || klass === 'cli-store' || klass === 'local'
  }
  statusService = createStatusService({
    providers: () => statusRows,
    isEnabled: statusEnabled,
    fetcher: statusFetcher,
    onChange: (statuses) => {
      const win = getWin()
      win?.webContents.send(UsageChannels.statusChanged, statuses)
      // An outage relabels failing tiles — re-push the enriched view too.
      win?.webContents.send(UsageChannels.changed, enrich(service?.list() ?? []))
    },
    cadenceMsOverride
  })

  // "They're down" ≠ "you're out": a provider OUTAGE relabels its failing
  // tile's reason and mutes the pace line — the red names the right culprit.
  const withOutage = (p: PlanUsage): PlanUsage => {
    if (p.health !== 'error' && p.health !== 'stale') return p
    const st = statusService?.list().find((s) => s.providerId === p.providerId)
    if (st?.state !== 'outage') return p
    return { ...p, reason: `provider outage — ${st.note ?? 'their status page reports an incident'}` }
  }
  // ── 7/10 display prefs: which plan the gauge mirrors, what the icon
  // shows, how resets render. KV-backed; the renderer paints, never decides.
  const displayCfg = (): UsageDisplayConfig => {
    const kv = getSettingsStore()
    const g = (k: string): string | null => kv?.getSetting(k) ?? null
    const bool = (k: string, dflt: boolean): boolean => {
      const v = g(k)
      return v === null ? dflt : v === '1'
    }
    const mode = g('usage.display.mode')
    const resetStyle = g('usage.display.reset')
    let pinOrder: string[] = []
    try {
      const arr = JSON.parse(g('usage.display.pinorder') ?? '[]') as unknown
      if (Array.isArray(arr)) pinOrder = arr.filter((x): x is string => typeof x === 'string').slice(0, 64)
    } catch {
      /* default */
    }
    return {
      mode: mode === 'pinned' || mode === 'auto' ? mode : USAGE_DISPLAY_DEFAULTS.mode,
      pin: g('usage.display.pin') ?? undefined,
      showBars: bool('usage.display.bars', USAGE_DISPLAY_DEFAULTS.showBars),
      showPct: bool('usage.display.pct', USAGE_DISPLAY_DEFAULTS.showPct),
      showGlyph: bool('usage.display.glyph', USAGE_DISPLAY_DEFAULTS.showGlyph),
      showLabel: bool('usage.display.label', USAGE_DISPLAY_DEFAULTS.showLabel),
      resetStyle: resetStyle === 'absolute' || resetStyle === 'relative' ? resetStyle : USAGE_DISPLAY_DEFAULTS.resetStyle,
      density: g('usage.display.density') === 'compact' ? 'compact' : USAGE_DISPLAY_DEFAULTS.density,
      order: g('usage.display.order') === 'manual' ? 'manual' : USAGE_DISPLAY_DEFAULTS.order,
      pinOrder
    }
  }

  const enrich = (plans: PlanUsage[]): PlanUsageView[] => {
    // Every reset line comes from THE reset formatter, in the ONE chosen style.
    const style = displayCfg().resetStyle
    const now = Date.now()
    return plans.map((p) => {
      const relabeled = withOutage(p)
      const view = toView(relabeled)
      const styled: PlanUsageView = {
        ...(relabeled !== p && view.pace ? { ...view, pace: undefined } : view),
        windows: view.windows.map((w) =>
          // The reset's OWN offset — "resets Sun 09:00" must hold across a DST
          // change, not shift by the hour the user has today.
          w.resetsAt ? { ...w, resetText: formatReset(w.resetsAt, style, now, tzAt(Date.parse(w.resetsAt))) ?? undefined } : w
        )
      }
      return styled
    })
  }

  // ── 7/09 threshold alerts: evaluated on every poller push (new samples
  // only — a re-enrich for status is not a new sample). Copy composed in the
  // backend module, single-fire state in the settings KV (restart-safe),
  // the toast rides the alert channel to the HOUSE toast system.
  const alertCfg = (): UsageAlertConfig => {
    const kv = getSettingsStore()
    const num = (key: string, dflt: number): number => {
      const v = Number(kv?.getSetting(key))
      return Number.isFinite(v) && v >= 1 && v <= 100 ? Math.round(v) : dflt
    }
    // Credits floors are per provider (usage.alert.floor.<id>), positive only.
    const floors: Record<string, number> = {}
    for (const def of USAGE_PROVIDERS) {
      if (!def.credits) continue
      const v = Number(kv?.getSetting(`usage.alert.floor.${def.id}`))
      if (Number.isFinite(v) && v > 0) floors[def.id] = v
    }
    return {
      quiet: num('usage.alert.quiet', USAGE_ALERT_DEFAULTS.quiet),
      warn: num('usage.alert.warn', USAGE_ALERT_DEFAULTS.warn),
      confetti: kv?.getSetting('usage.alert.confetti') === '1',
      ...(Object.keys(floors).length ? { floors } : {})
    }
  }
  // ── Guaranteed delivery (phase-11 rebuild). The engine spends single-fire
  // state the moment it decides to alert — so the decision and the delivery
  // must not share a fate. Every alert lands in a KV OUTBOX first; the send is
  // just a hint. The renderer acks each toast it actually rendered, and drains
  // the outbox on mount — the boot race (first poll beats the subscriber),
  // getWin() null, and a recreated window all become replays, never losses.
  const OUTBOX_KEY = 'usage.alert.outbox'
  const OUTBOX_CAP = 20
  const OUTBOX_TTL_MS = 24 * 3_600_000
  type QueuedAlert = UsageAlert & { alertId: string; queuedAt: number }
  let alertSeq = 0
  const readOutbox = (): QueuedAlert[] => {
    try {
      const arr = JSON.parse(getSettingsStore()?.getSetting(OUTBOX_KEY) ?? '[]') as QueuedAlert[]
      return Array.isArray(arr) ? arr.filter((a) => a && typeof a.alertId === 'string') : []
    } catch {
      return []
    }
  }
  const writeOutbox = (q: QueuedAlert[]): void =>
    getSettingsStore()?.setSetting(OUTBOX_KEY, JSON.stringify(q.slice(-OUTBOX_CAP)))
  const pushAlerts = (views: PlanUsageView[]): void => {
    const kv = getSettingsStore()
    if (!kv) return
    const cfg = alertCfg()
    const alerts = evaluateThresholds(views, cfg, kv.listProfiles(), {
      get: (k) => kv.getSetting(k) ?? null,
      set: (k, v) => kv.setSetting(k, v)
    })
    if (!alerts.length) return
    const queued: QueuedAlert[] = alerts.map((a) => ({
      ...(a.kind === 'reset' && cfg.confetti ? { ...a, confetti: true } : a),
      alertId: `${Date.now().toString(36)}-${++alertSeq}`,
      queuedAt: Date.now()
    }))
    writeOutbox([...readOutbox(), ...queued])
    const win = getWin()
    if (win && !win.isDestroyed()) for (const a of queued) win.webContents.send(UsageChannels.alert, a)
  }

  service = createUsageService({
    adapters,
    profiles: () => getSettingsStore()?.listProfiles() ?? [],
    kv: {
      get: (k) => getSettingsStore()?.getSetting(k) ?? null,
      set: (k, v) => getSettingsStore()?.setSetting(k, v)
    },
    onChange: (plans) => {
      const views = enrich(plans)
      getWin()?.webContents.send(UsageChannels.changed, views)
      pushAlerts(views) // new samples -> the thresholds get one look
    },
    cadenceMsOverride
  })

  ipcMain.handle(UsageChannels.list, () => enrich(service?.list() ?? []))
  ipcMain.handle(UsageChannels.refresh, () => service?.refresh())
  ipcMain.handle(UsageChannels.status, () => statusService?.list() ?? [])
  // 7/10 display prefs: validate, persist, push both the config and the
  // re-styled views (resetText follows the style) — paint-only downstream.
  ipcMain.handle(UsageChannels.displayGet, (): UsageDisplayConfig => displayCfg())
  ipcMain.handle(UsageChannels.displaySet, (_e, raw: unknown) => {
    const p = raw as Partial<UsageDisplayConfig> | null
    const kv = getSettingsStore()
    if (!p || !kv) return
    const ID = /^[\w.-]{1,64}$/
    if (p.mode === 'merged' || p.mode === 'pinned' || p.mode === 'auto') kv.setSetting('usage.display.mode', p.mode)
    if (typeof p.pin === 'string' && ID.test(p.pin)) kv.setSetting('usage.display.pin', p.pin)
    if (typeof p.showBars === 'boolean') kv.setSetting('usage.display.bars', p.showBars ? '1' : '0')
    if (typeof p.showPct === 'boolean') kv.setSetting('usage.display.pct', p.showPct ? '1' : '0')
    if (typeof p.showGlyph === 'boolean') kv.setSetting('usage.display.glyph', p.showGlyph ? '1' : '0')
    if (typeof p.showLabel === 'boolean') kv.setSetting('usage.display.label', p.showLabel ? '1' : '0')
    if (p.resetStyle === 'countdown' || p.resetStyle === 'absolute' || p.resetStyle === 'relative')
      kv.setSetting('usage.display.reset', p.resetStyle)
    if (p.density === 'roomy' || p.density === 'compact') kv.setSetting('usage.display.density', p.density)
    if (p.order === 'severity' || p.order === 'manual') kv.setSetting('usage.display.order', p.order)
    if (Array.isArray(p.pinOrder))
      kv.setSetting('usage.display.pinorder', JSON.stringify(p.pinOrder.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 64)))
    const win = getWin()
    win?.webContents.send(UsageChannels.displayChanged, displayCfg())
    win?.webContents.send(UsageChannels.changed, enrich(service?.list() ?? []))
  })

  // The outbox's two verbs. Drain does NOT clear — only an ack does, because
  // "the invoke resolved" and "a toast reached the DOM" are different facts.
  // TTL'd so week-old news cannot replay after a vacation.
  ipcMain.handle(UsageChannels.alertDrain, (): (UsageAlert & { alertId: string })[] => {
    const fresh = readOutbox().filter((a) => Date.now() - a.queuedAt < OUTBOX_TTL_MS)
    writeOutbox(fresh)
    return fresh
  })
  ipcMain.handle(UsageChannels.alertAck, (_e, alertId: unknown) => {
    if (typeof alertId !== 'string' || !alertId) return
    writeOutbox(readOutbox().filter((a) => a.alertId !== alertId))
  })

  // 7/09 alert config: two shoulder-tap pcts + the confetti opt-in.
  ipcMain.handle(UsageChannels.alertCfgGet, (): UsageAlertConfig => alertCfg())
  ipcMain.handle(UsageChannels.alertCfgSet, (_e, raw: unknown) => {
    const p = raw as { quiet?: number; warn?: number; confetti?: boolean; floors?: Record<string, unknown> } | null
    const kv = getSettingsStore()
    if (!p || !kv) return
    if (typeof p.quiet === 'number' && p.quiet >= 1 && p.quiet <= 100) kv.setSetting('usage.alert.quiet', String(Math.round(p.quiet)))
    if (typeof p.warn === 'number' && p.warn >= 1 && p.warn <= 100) kv.setSetting('usage.alert.warn', String(Math.round(p.warn)))
    if (typeof p.confetti === 'boolean') kv.setSetting('usage.alert.confetti', p.confetti ? '1' : '0')
    if (p.floors && typeof p.floors === 'object') {
      for (const [id, v] of Object.entries(p.floors)) {
        if (!findProvider(id)?.credits) continue // floors exist only for balance rows
        const n = Number(v)
        if (Number.isFinite(n) && n >= 0) kv.setSetting(`usage.alert.floor.${id}`, n > 0 ? String(n) : '')
      }
    }
  })

  // The Usage tab's surface (7/12): rows are the UNION of the catalog and
  // the registered adapters (the FAKE world registers only its fixture
  // adapter, but the tab still shows — and keeps key PRESENCE truthful for —
  // every catalog row). `enabled` mirrors the SEAM's class-aware default so
  // the grid never claims a lane the poller isn't reading.
  ipcMain.handle(UsageChannels.configGet, (): UsageConfig => {
    const kv = getSettingsStore()
    const ids = [...new Set([...USAGE_PROVIDERS.map((p) => p.id), ...adapters.map((a) => a.id)])]
    return {
      providers: ids.map((id) => ({
        id,
        enabled: statusEnabled(id), // the seam's rule, verbatim
        cadence: (kv?.getSetting(`usage.cadence.${id}`) ?? '5m') as UsageCadence,
        // PRESENCE only (ADR 0007.a) — the kind, never a value.
        key: keySlot(id).kind,
        // web-session store-read opt-in (ADR 0007.b), default OFF.
        webRead: findProvider(id)?.klass === 'web-session' ? kv?.getSetting(`usage.webread.${id}`) === '1' : undefined
      }))
    }
  })
  const configurable = (id: string): boolean =>
    adapters.some((a) => a.id === id) || USAGE_PROVIDERS.some((p) => p.id === id)
  ipcMain.handle(UsageChannels.configSet, (_e, raw: unknown) => {
    const p = raw as UsageConfigPatch | null
    if (!p || typeof p.providerId !== 'string' || !configurable(p.providerId)) return
    const kv = getSettingsStore()
    if (typeof p.enabled === 'boolean') kv?.setSetting(`usage.enabled.${p.providerId}`, p.enabled ? '1' : '0')
    if (p.cadence && (USAGE_CADENCES as readonly string[]).includes(p.cadence))
      kv?.setSetting(`usage.cadence.${p.providerId}`, p.cadence)
    // Apply live: re-poll (restarts a disabled chain) + push the filtered view.
    if (p.enabled !== false) service?.refresh(p.providerId)
    getWin()?.webContents.send(UsageChannels.changed, enrich(service?.list() ?? []))
  })

  // Keys (ADR 0007.a): WRITE-ONLY — set encrypts immediately, clear removes;
  // there is NO getter handler anywhere, by design.
  ipcMain.handle(UsageChannels.keySet, (_e, raw: unknown) => {
    const p = raw as { providerId?: string; plaintext?: string; envRef?: string } | null
    if (!p || typeof p.providerId !== 'string') return { ok: false, reason: 'bad request' }
    const out =
      typeof p.envRef === 'string'
        ? keySetEnvRef(p.providerId, p.envRef)
        : keySetPlaintext(p.providerId, String(p.plaintext ?? ''))
    if (out.ok) {
      // A configured key turns its provider ON (api-key rows default off).
      getSettingsStore()?.setSetting(`usage.enabled.${p.providerId}`, '1')
      service?.refresh(p.providerId)
    }
    return out // ok/reason only — the plaintext is never echoed
  })
  ipcMain.handle(UsageChannels.keyClear, (_e, providerId: unknown) => {
    if (typeof providerId !== 'string' || !providerId) return
    keyClear(providerId)
    service?.refresh(providerId)
    getWin()?.webContents.send(UsageChannels.changed, enrich(service?.list() ?? []))
  })
  // web-session store-read consent (ADR 0007.b): per-provider, default OFF.
  ipcMain.handle(UsageChannels.webReadSet, (_e, raw: unknown) => {
    const p = raw as { providerId?: string; enabled?: boolean } | null
    if (!p || typeof p.providerId !== 'string') return
    getSettingsStore()?.setSetting(`usage.webread.${p.providerId}`, p.enabled ? '1' : '0')
    if (p.enabled) getSettingsStore()?.setSetting(`usage.enabled.${p.providerId}`, '1')
    service?.refresh(p.providerId)
    getWin()?.webContents.send(UsageChannels.changed, enrich(service?.list() ?? []))
  })

  // 7/07 — cost scan (on demand: it reads disk, NEVER on the poll cadence) +
  // history ring (our own KV counts). Same FAKE-under-smoke rule as the
  // poller: a usage-fixture world scans ONLY the seeded MOGGING_USAGE_COSTDIR;
  // any other smoke gets a labeled empty scan; real log dirs are touched in a
  // real session alone. No log path, spend figure, or token count leaves the
  // machine (ADR 0005) — these are render-only payloads.

  // ── Live pricing (the CodexBar models.dev idea): one bounded PUBLIC request
  // (no auth, no cookies) to models.dev, at most daily, persisted in the KV —
  // scanned spend then prices at today's published rates instead of the last
  // release's built-ins. The scan itself stays network-free: rates arrive as
  // DATA. Real sessions only (never under smoke); every failure path falls
  // back to the built-in table silently.
  const PRICES_TTL_MS = 24 * 3_600_000
  interface LivePrices {
    at: number
    rows: [string, { inPerMTok: number; outPerMTok: number }][]
  }
  let livePrices: LivePrices | null = null
  let pricesFetching = false
  const loadLivePrices = (): void => {
    if (livePrices) return
    try {
      const raw = getSettingsStore()?.getSetting('usage.prices.modelsdev')
      if (raw) {
        const p = JSON.parse(raw) as LivePrices | null
        if (p && Array.isArray(p.rows) && typeof p.at === 'number') livePrices = p
      }
    } catch {
      /* corrupt cache — refetch below */
    }
  }
  const refreshLivePrices = (): void => {
    if (world || pricesFetching) return // real sessions only — a harness world never reaches out
    loadLivePrices()
    if (livePrices && Date.now() - livePrices.at < PRICES_TTL_MS) return
    pricesFetching = true
    void fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(8000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (!body || typeof body !== 'object') return
        const rows: [string, { inPerMTok: number; outPerMTok: number }][] = []
        for (const providerKey of ['anthropic', 'openai']) {
          const models = (body as Record<string, { models?: Record<string, { cost?: { input?: unknown; output?: unknown } }> }>)[providerKey]?.models
          if (!models || typeof models !== 'object') continue
          for (const [id, m] of Object.entries(models)) {
            const inP = m?.cost?.input
            const outP = m?.cost?.output
            if (typeof inP === 'number' && typeof outP === 'number' && inP >= 0 && outP >= 0)
              rows.push([id.toLowerCase(), { inPerMTok: inP, outPerMTok: outP }])
          }
        }
        if (!rows.length) return
        // Longest id first, so "gpt-5.4-mini" wins its prefix race with "gpt-5".
        rows.sort((a, b) => b[0].length - a[0].length)
        livePrices = { at: Date.now(), rows: rows.slice(0, 500) }
        getSettingsStore()?.setSetting('usage.prices.modelsdev', JSON.stringify(livePrices))
      })
      .catch(() => undefined) // offline / blocked — built-ins carry on
      .finally(() => {
        pricesFetching = false
      })
  }

  // The ACTIVE lane of a provider: order 0 wins, the poller's own rule. Null
  // when no profile targets it (the seam calls that lane 'default').
  const activeProfile = (providerId: string): AgentProfile | null => {
    const forProvider = (getSettingsStore()?.listProfiles() ?? []).filter((p) => p.provider === providerId)
    return forProvider.length ? forProvider.reduce((a, b) => (a.order <= b.order ? a : b)) : null
  }

  // One cost-scan rule for BOTH consumers (IPC + the 7/11 CLI endpoint): a
  // harness world scans what IT says (a seeded fixture dir, or a labeled
  // refusal); the real known log dirs are read in a real session alone.
  const costScanFor = (providerId: string, windowDays?: number): CostScan => {
    if (world) return world.costScan(providerId, windowDays)
    const windowOpts = windowDays !== undefined ? { windowDays } : {}
    refreshLivePrices() // async; THIS scan uses whatever is cached, the next one the fresh rates
    const priceOpts = livePrices ? { prices: livePrices.rows, pricesRev: String(livePrices.at) } : {}
    const profile = activeProfile(providerId) // the ACTIVE profile's home
    // EVERY root the provider writes (archived sessions, moved config homes) —
    // the single-root scan silently under-counted both (CodexBar parity).
    return scanCost(providerId, costLogDirs(providerId, resolveHome(providerId, profile)), { ...priceOpts, ...windowOpts })
  }
  // Payload: a bare provider id (the historical shape) or `{ providerId,
  // windowDays }` — the Cost overview's window select (7..365, clamped).
  ipcMain.handle(UsageChannels.cost, async (_e, req: unknown): Promise<CostScan> => {
    // Finding 39's seam: BOTH cost surfaces read this one channel — the popover row (which used to
    // sit on "Cost…" forever when the scan never came back) and the Settings § Usage card (whose
    // per-provider loop had no catch at all). Hang it, reject it, and both must give up out loud.
    await maybeFault(UsageChannels.cost)
    const providerId = typeof req === 'string' ? req : ((req as { providerId?: unknown } | null)?.providerId as string | undefined)
    if (typeof providerId !== 'string' || !providerId)
      return { providerId: '', days: [], currency: 'USD', reason: 'bad request' }
    const rawWd = typeof req === 'object' && req ? Number((req as { windowDays?: unknown }).windowDays) : NaN
    const windowDays = Number.isFinite(rawWd) ? Math.max(1, Math.min(365, Math.round(rawWd))) : undefined
    return costScanFor(providerId, windowDays)
  })

  // 7/11: hand the CLI endpoint its accessors (same enrich, same cost rule,
  // same provider composition as the Settings stub).
  cliViews = () => enrich(service?.list() ?? [])
  cliCost = costScanFor
  cliProviders = () =>
    adapters.map((a) => {
      const def = findProvider(a.id)
      const kv = getSettingsStore()
      const plans = service?.list().filter((p) => p.providerId === a.id) ?? []
      return {
        id: a.id,
        label: def?.label ?? a.id,
        klass: def?.klass ?? 'local',
        enabled: kv?.getSetting(`usage.enabled.${a.id}`) !== '0',
        key: keySlot(a.id).kind,
        health: plans[0]?.health ?? 'unconfigured'
      }
    })
  ipcMain.handle(UsageChannels.history, (_e, raw: unknown): number[] => {
    const p = raw as { providerId?: string; window?: string; profileId?: string } | null
    if (!p || typeof p.providerId !== 'string' || typeof p.window !== 'string') return []
    const kv = getSettingsStore()
    if (!kv) return []
    // Rings are per LANE (7/07). A caller that names no profile wants the lane
    // the user is actually on — the ACTIVE one, the same rule the cost scan
    // resolves a home by. No profile on the provider = the 'default' ring.
    const profileId = typeof p.profileId === 'string' && p.profileId ? p.profileId : activeProfile(p.providerId)?.id
    return readHistory({ get: (k) => kv.getSetting(k) ?? null, set: (k, v) => kv.setSetting(k, v) }, p.providerId, p.window, profileId)
  })

  // Hidden window = paused poller (poll politely). Single-window app: the
  // main window is the only BrowserWindow main creates.
  app.on('browser-window-created', (_e, w) => {
    w.on('hide', () => {
      service?.setVisible(false)
      statusService?.setVisible(false)
    })
    w.on('minimize', () => {
      service?.setVisible(false)
      statusService?.setVisible(false)
    })
    w.on('show', () => {
      service?.setVisible(true)
      statusService?.setVisible(true)
    })
    w.on('restore', () => {
      service?.setVisible(true)
      statusService?.setVisible(true)
    })
  })
  app.on('before-quit', () => {
    service?.stop()
    statusService?.stop()
  })
}
