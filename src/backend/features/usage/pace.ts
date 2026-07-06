import type { PaceReport, PaceVerdict, ResetStyle, UsageWindow } from '@contracts'

// The pace engine (Phase-7/02). PURE is the contract: zero I/O, zero
// Date.now(), zero config reads — the clock, the window length, the
// work-day baseline, and any recent observation are ARGUMENTS. That purity
// is what makes the golden table trustworthy and CI-deterministic.
//
// Staleness is the CALLER's job: a stale/unconfigured snapshot should render
// its age ("as of 12m ago"), not a forecast — don't call the engine for it.

export interface PaceOptions {
  /** Window length in ms (5h session = 18_000_000; weekly = 604_800_000). */
  windowMs: number
  /** Work-day baseline: days 0(Sun)–6(Sat) that count as active. */
  workDays?: number[]
  /** Active hours within a work day, [startHour, endHour) in 0–24. */
  workHours?: [number, number]
  /** Offset applied before calendar math (default 0 = UTC). Production passes
   *  the user's local offset; fixtures pass 0 for determinism. */
  tzOffsetMinutes?: number
  /** A previous observation of the SAME window — lets a sprint TODAY move the
   *  forecast before the window average notices. */
  recent?: { usedPct: number; atMs: number }
}

/** |paceDelta| within this band reads on-pace; runs-out needs the projection
 *  to land earlier than reset by MORE than this share of the window; surplus
 *  needs more than this many projected-unused points. One knob, one meaning. */
export const ON_PACE_BAND_PCT = 5
/** Below this elapsed share the window is warming up — never a verdict
 *  louder than on-pace (a fresh window must not scream). */
export const WARMUP_ELAPSED_PCT = 10
/** Blend weight for the recent-observation rate over the window average. */
export const RECENT_RATE_WEIGHT = 0.6

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const hasBaseline = (o: PaceOptions): boolean =>
  Array.isArray(o.workDays) && o.workDays.length > 0 && Array.isArray(o.workHours)

/** Active milliseconds in [from, to) under the baseline (calendar ms without one). */
function activeMs(from: number, to: number, o: PaceOptions): number {
  if (to <= from) return 0
  if (!hasBaseline(o)) return to - from
  const off = (o.tzOffsetMinutes ?? 0) * 60_000
  const [startH, endH] = o.workHours as [number, number]
  const days = new Set(o.workDays)
  let total = 0
  // Walk local-shifted days; overlap each work span with [from, to).
  let dayStart = Math.floor((from + off) / DAY_MS) * DAY_MS - off
  for (; dayStart < to; dayStart += DAY_MS) {
    const dow = new Date(dayStart + off).getUTCDay()
    if (!days.has(dow)) continue
    const spanStart = dayStart + startH * HOUR_MS
    const spanEnd = dayStart + endH * HOUR_MS
    total += Math.max(0, Math.min(to, spanEnd) - Math.max(from, spanStart))
  }
  return total
}

/** The timestamp at which `hoursNeeded` ACTIVE hours have elapsed after `from`. */
function activeHoursEnd(from: number, hoursNeeded: number, o: PaceOptions): number {
  if (!hasBaseline(o)) return from + hoursNeeded * HOUR_MS
  const off = (o.tzOffsetMinutes ?? 0) * 60_000
  const [startH, endH] = o.workHours as [number, number]
  const days = new Set(o.workDays)
  let remaining = hoursNeeded * HOUR_MS
  let dayStart = Math.floor((from + off) / DAY_MS) * DAY_MS - off
  for (let i = 0; i < 800; i++, dayStart += DAY_MS) {
    const dow = new Date(dayStart + off).getUTCDay()
    if (!days.has(dow)) continue
    const spanStart = Math.max(from, dayStart + startH * HOUR_MS)
    const spanEnd = dayStart + endH * HOUR_MS
    const avail = spanEnd - spanStart
    if (avail <= 0) continue
    if (remaining <= avail) return spanStart + remaining
    remaining -= avail
  }
  return from + hoursNeeded * HOUR_MS // degenerate baseline: fall back to calendar
}

/** Pace one window. Returns null when there isn't enough data to pace —
 *  no reset time, no window length, or a nonsensical usedPct (the caller
 *  renders snapshot age instead; verdicts never speculate past the data). */
export function computePace(w: UsageWindow, now: number, opts: PaceOptions): PaceReport | null {
  if (!w.resetsAt || !Number.isFinite(opts.windowMs) || opts.windowMs <= 0) return null
  if (!Number.isFinite(w.usedPct) || w.usedPct < 0) return null
  const resetMs = Date.parse(w.resetsAt)
  if (!Number.isFinite(resetMs)) return null
  const startMs = resetMs - opts.windowMs
  const used = Math.min(100, w.usedPct)

  let elapsedActive = activeMs(startMs, Math.min(now, resetMs), opts)
  let totalActive = activeMs(startMs, resetMs, opts)
  if (totalActive <= 0) {
    // Baseline excludes the whole window — pace against the calendar instead.
    elapsedActive = Math.min(now, resetMs) - startMs
    totalActive = opts.windowMs
  }
  const elapsedPct = Math.max(0, Math.min(100, (elapsedActive / totalActive) * 100))
  const paceDelta = used - elapsedPct

  // Blended burn: window average, pulled toward a recent observation so a
  // sprint today moves the forecast before the weekly average notices.
  const elapsedHours = elapsedActive / HOUR_MS
  const windowAvg = elapsedHours > 0 ? used / elapsedHours : 0
  let burnRate = windowAvg
  const r = opts.recent
  if (r && r.atMs < now && Number.isFinite(r.usedPct) && used >= r.usedPct) {
    const recentHours = activeMs(r.atMs, now, opts) / HOUR_MS
    if (recentHours > 0) {
      const recentRate = (used - r.usedPct) / recentHours
      burnRate = RECENT_RATE_WEIGHT * recentRate + (1 - RECENT_RATE_WEIGHT) * windowAvg
    }
  }

  let runOutAt: number | undefined
  let surplusPct: number | undefined
  if (used >= 100) {
    runOutAt = now
  } else if (burnRate > 0) {
    const projected = activeHoursEnd(now, (100 - used) / burnRate, opts)
    if (projected < resetMs) runOutAt = projected
    else surplusPct = Math.max(0, 100 - (used + (activeMs(now, resetMs, opts) / HOUR_MS) * burnRate))
  } else {
    surplusPct = 100 - used
  }

  let verdict: PaceVerdict = 'on-pace'
  const warmingUp = elapsedPct < WARMUP_ELAPSED_PCT && used < 100
  if (!warmingUp) {
    const earlyByMs = runOutAt !== undefined ? resetMs - runOutAt : 0
    if (runOutAt !== undefined && earlyByMs > (ON_PACE_BAND_PCT / 100) * opts.windowMs) verdict = 'runs-out'
    else if (surplusPct !== undefined && surplusPct > ON_PACE_BAND_PCT) verdict = 'surplus'
  }

  return { verdict, paceDelta, elapsedPct, burnRatePctPerHour: burnRate, runOutAt, surplusPct }
}

// ── The ONE formatter (binding wording — every surface renders these) ────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** "Tue 14:00" — weekday + 24h HH:MM, shifted by tzOffsetMinutes (default UTC). */
export function formatPaceTime(atMs: number, tzOffsetMinutes = 0): string {
  const d = new Date(atMs + tzOffsetMinutes * 60_000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${DAY_NAMES[d.getUTCDay()]} ${hh}:${mm}`
}

/** "+12%" / "-3%" / unsigned "0%" when it rounds to zero. */
export function formatPaceDelta(paceDelta: number): string {
  const r = Math.round(paceDelta)
  if (r === 0) return '0%'
  return r > 0 ? `+${r}%` : `${r}%`
}

/** THE three strings. A rewording here is a contract change — the golden
 *  fixtures assert these exact outputs and must move with it. */
export function formatVerdict(report: PaceReport, windowLabel: string, tzOffsetMinutes = 0): string {
  switch (report.verdict) {
    case 'runs-out':
      return `Ahead of pace — runs out ~${formatPaceTime(report.runOutAt ?? 0, tzOffsetMinutes)} at this rate`
    case 'surplus':
      return `Behind pace — ~${Math.round(report.surplusPct ?? 0)}% likely unused at reset`
    case 'on-pace':
      return `On pace for the ${windowLabel} window`
  }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** THE reset formatter (7/10): every surface that renders a reset moment —
 *  popover rows, the Usage tab, the CLI — renders THIS string in the user's
 *  ONE chosen style. Pure like the rest of the engine: clock + tz are
 *  arguments. Countdown keeps the popover's historical wording verbatim. */
export function formatReset(resetsAt: string, style: ResetStyle, now: number, tzOffsetMinutes = 0): string | null {
  const t = Date.parse(resetsAt)
  if (!Number.isFinite(t)) return null
  const diffMs = Math.max(0, t - now)
  if (style === 'countdown') {
    let s = Math.max(0, Math.round(diffMs / 1000))
    const d = Math.floor(s / 86400)
    s -= d * 86400
    const h = Math.floor(s / 3600)
    const m = Math.floor((s - h * 3600) / 60)
    if (d > 0) return `resets in ${d}d ${h}h`
    if (h > 0) return `resets in ${h}h ${m}m`
    return `resets in ${m}m`
  }
  const local = new Date(t + tzOffsetMinutes * 60_000)
  const localNow = new Date(now + tzOffsetMinutes * 60_000)
  const hhmm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  const sameLocalDay = (a: Date, b: Date): boolean =>
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
  if (style === 'absolute') {
    if (sameLocalDay(local, localNow)) return `resets ${hhmm}`
    if (diffMs < 7 * DAY_MS) return `resets ${DAY_NAMES[local.getUTCDay()]} ${hhmm}`
    return `resets ${MONTH_NAMES[local.getUTCMonth()]} ${local.getUTCDate()}`
  }
  // relative words: the nearest human phrase, details only when they help
  if (diffMs < HOUR_MS) return 'resets within the hour'
  if (sameLocalDay(local, localNow)) return `resets today ${hhmm}`
  if (sameLocalDay(local, new Date(localNow.getTime() + DAY_MS))) return `resets tomorrow ${hhmm}`
  if (diffMs < 7 * DAY_MS) return `resets ${DAY_NAMES[local.getUTCDay()]}`
  return `resets in ${Math.round(diffMs / DAY_MS)} days`
}

/** Severity ink per verdict (docs/11 tokens; UI maps to classes). */
export const PACE_SEVERITY: Record<PaceVerdict, 'warning' | 'neutral' | 'quiet'> = {
  'runs-out': 'warning',
  'on-pace': 'neutral',
  surplus: 'quiet'
}
