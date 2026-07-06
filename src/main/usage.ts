import { app, ipcMain, type BrowserWindow } from 'electron'
import { UsageChannels, USAGE_CADENCES, type PlanUsage, type UsageCadence } from '@contracts'
import type { PlanUsageView, PaceView, UsageConfig, UsageConfigPatch, CostScan } from '@contracts'
import {
  createUsageService,
  fakeAdapter,
  buildRealAdapters,
  realCookieBackend,
  computePace,
  formatVerdict,
  formatPaceDelta,
  PACE_SEVERITY,
  resolveHome,
  scanCost,
  costLogDir,
  readHistory,
  type UsageService
} from '@backend/features/usage'
import { getSettingsStore } from './app-settings'
import { keySlot, keySetPlaintext, keySetEnvRef, keyClear, resolveKey } from './usage-keys'

// App-wiring: usage meters (Phase-7/01+03, ADR 0007). Adapter pick is the
// zero-network guarantee: under a usage smoke (or the gallery) the registry
// holds ONLY the FAKE adapter; under any OTHER smoke it holds nothing; real
// adapters exist only in a real session. Main feeds the poller window
// visibility, fans snapshot changes out on one push channel, and — 7/03 —
// attaches the PACE VIEW here, so the ONE backend formatter produces every
// string the renderer shows. No token, path, or account id crosses this file.

let service: UsageService | null = null

/** Smoke hook: direct service access (main-side only). */
export function getUsageService(): UsageService | null {
  return service
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

const SEVERITY_RANK = { 'runs-out': 2, surplus: 1, 'on-pace': 0 } as const

/** Attach the worst window's pace to a plan (fresh/stale only — an
 *  error/unconfigured tile renders its age + reason, never a forecast). */
function toView(p: PlanUsage): PlanUsageView {
  if (p.health !== 'fresh' && p.health !== 'stale') return p
  const tz = -new Date().getTimezoneOffset()
  let best: PaceView | undefined
  let bestRank = -1
  for (const w of p.windows) {
    const windowMs = w.windowMs && w.windowMs > 0 ? w.windowMs : windowMsFor(w.label)
    if (!windowMs) continue
    const report = computePace(w, Date.now(), { windowMs, tzOffsetMinutes: tz })
    if (!report) continue
    const rank = SEVERITY_RANK[report.verdict]
    if (rank > bestRank) {
      bestRank = rank
      best = {
        verdict: report.verdict,
        text: formatVerdict(report, w.label, tz),
        deltaText: formatPaceDelta(report.paceDelta),
        severity: PACE_SEVERITY[report.verdict]
      }
    }
  }
  return best ? { ...p, pace: best } : p
}

export function registerUsage(getWin: () => BrowserWindow | null): void {
  const isSmoke = Object.keys(process.env).some((k) => k.startsWith('MOGGING_'))
  const isFixtureWorld =
    Object.keys(process.env).some((k) => k.startsWith('MOGGING_USAGE')) || !!process.env.MOGGING_GALLERY
  // web-session deps (ADR 0007.b): a pasted cookie rides the SAME write-only
  // store as a key; store-read is per-provider opt-in (default OFF) and only
  // then may the real cookie backend be touched.
  const webDeps = {
    pasteValue: (id: string) => resolveKey(id),
    storeReadEnabled: (id: string) => getSettingsStore()?.getSetting(`usage.webread.${id}`) === '1',
    readCookie: (origin: string, name: string) => realCookieBackend.read(origin, name)
  }
  const adapters = isFixtureWorld ? [fakeAdapter] : isSmoke ? [] : buildRealAdapters({ resolveKey }, webDeps)

  const cadenceEnv = Number(process.env.MOGGING_USAGE_CADENCE_MS)
  const cadenceMsOverride = Number.isFinite(cadenceEnv) && cadenceEnv > 0 ? cadenceEnv : isFixtureWorld ? 400 : undefined

  const enrich = (plans: PlanUsage[]): PlanUsageView[] => plans.map(toView)

  service = createUsageService({
    adapters,
    profiles: () => getSettingsStore()?.listProfiles() ?? [],
    kv: {
      get: (k) => getSettingsStore()?.getSetting(k) ?? null,
      set: (k, v) => getSettingsStore()?.setSetting(k, v)
    },
    onChange: (plans) => getWin()?.webContents.send(UsageChannels.changed, enrich(plans)),
    cadenceMsOverride
  })

  ipcMain.handle(UsageChannels.list, () => enrich(service?.list() ?? []))
  ipcMain.handle(UsageChannels.refresh, () => service?.refresh())

  // The 7/03 settings stub's surface (12 grows it): enable + cadence per provider.
  ipcMain.handle(UsageChannels.configGet, (): UsageConfig => {
    const kv = getSettingsStore()
    return {
      providers: adapters.map((a) => ({
        id: a.id,
        enabled: kv?.getSetting(`usage.enabled.${a.id}`) !== '0',
        cadence: (kv?.getSetting(`usage.cadence.${a.id}`) ?? '5m') as UsageCadence,
        // PRESENCE only (ADR 0007.a) — the kind, never a value.
        key: keySlot(a.id).kind,
        // web-session store-read opt-in (ADR 0007.b), default OFF.
        webRead: getSettingsStore()?.getSetting(`usage.webread.${a.id}`) === '1'
      }))
    }
  })
  ipcMain.handle(UsageChannels.configSet, (_e, raw: unknown) => {
    const p = raw as UsageConfigPatch | null
    if (!p || typeof p.providerId !== 'string' || !adapters.some((a) => a.id === p.providerId)) return
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
  ipcMain.handle(UsageChannels.cost, (_e, providerId: unknown): CostScan => {
    if (typeof providerId !== 'string' || !providerId)
      return { providerId: '', days: [], currency: 'USD', reason: 'bad request' }
    if (isFixtureWorld) return scanCost(providerId, process.env.MOGGING_USAGE_COSTDIR ?? null)
    if (isSmoke) return { providerId, days: [], currency: 'USD', reason: 'cost scan is disabled under smoke' }
    // The ACTIVE profile's home, same rule as the poller (order 0 wins).
    const forProvider = (getSettingsStore()?.listProfiles() ?? []).filter((p) => p.provider === providerId)
    const profile = forProvider.length ? forProvider.reduce((a, b) => (a.order <= b.order ? a : b)) : null
    return scanCost(providerId, costLogDir(providerId, resolveHome(providerId, profile)))
  })
  ipcMain.handle(UsageChannels.history, (_e, raw: unknown): number[] => {
    const p = raw as { providerId?: string; window?: string } | null
    if (!p || typeof p.providerId !== 'string' || typeof p.window !== 'string') return []
    const kv = getSettingsStore()
    if (!kv) return []
    return readHistory({ get: (k) => kv.getSetting(k) ?? null, set: (k, v) => kv.setSetting(k, v) }, p.providerId, p.window)
  })

  // Hidden window = paused poller (poll politely). Single-window app: the
  // main window is the only BrowserWindow main creates.
  app.on('browser-window-created', (_e, w) => {
    w.on('hide', () => service?.setVisible(false))
    w.on('minimize', () => service?.setVisible(false))
    w.on('show', () => service?.setVisible(true))
    w.on('restore', () => service?.setVisible(true))
  })
  app.on('before-quit', () => service?.stop())
}
