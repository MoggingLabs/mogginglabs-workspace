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

/** Pace one window — pure burn-rate arithmetic over what the meter itself
 *  knows: usage consumed, time elapsed, time left to reset. (The 7/12
 *  work-day baseline is gone: a forecast that needed the user to describe
 *  their work week was the model apologizing for itself.) Returns null when
 *  there isn't enough data to pace — no reset time, no window length, or a
 *  nonsensical usedPct (the caller renders snapshot age instead; verdicts
 *  never speculate past the data). */
export function computePace(w: UsageWindow, now: number, opts: PaceOptions): PaceReport | null {
  if (!w.resetsAt || !Number.isFinite(opts.windowMs) || opts.windowMs <= 0) return null
  if (!Number.isFinite(w.usedPct) || w.usedPct < 0) return null
  const resetMs = Date.parse(w.resetsAt)
  if (!Number.isFinite(resetMs)) return null
  const startMs = resetMs - opts.windowMs
  const used = Math.min(100, w.usedPct)

  const elapsed = Math.max(0, Math.min(now, resetMs) - startMs)
  const elapsedPct = Math.max(0, Math.min(100, (elapsed / opts.windowMs) * 100))
  const paceDelta = used - elapsedPct

  // Blended burn: window average, pulled toward a recent observation so a
  // sprint today moves the forecast before the weekly average notices.
  const elapsedHours = elapsed / HOUR_MS
  const windowAvg = elapsedHours > 0 ? used / elapsedHours : 0
  let burnRate = windowAvg
  const r = opts.recent
  if (r && r.atMs < now && Number.isFinite(r.usedPct) && used >= r.usedPct) {
    const recentHours = (now - r.atMs) / HOUR_MS
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
    const projected = now + ((100 - used) / burnRate) * HOUR_MS
    if (projected < resetMs) runOutAt = projected
    else surplusPct = Math.max(0, 100 - (used + ((resetMs - now) / HOUR_MS) * burnRate))
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

  const runOutRiskPct = warmingUp ? undefined : runOutRisk(used, burnRate, (resetMs - now) / HOUR_MS)

  return { verdict, paceDelta, elapsedPct, burnRatePctPerHour: burnRate, runOutAt, surplusPct, ...(runOutRiskPct !== undefined ? { runOutRiskPct } : {}) }
}

// ── Run-out risk (the CodexBar "≈ N% run-out risk" idea, honestly modeled):
//    P(exhaust before reset) under the ONE stated assumption that the blended
//    burn rate holds ± 50% (a fixed coefficient of variation — a modeling
//    choice, not a measurement; the copy says "risk", never a certainty).
//    z = (points left − expected further burn) / (0.5 · expected further burn),
//    p = 1 − Φ(z), rounded to the nearest 5 like the reference. Suppressed at
//    the certain ends (< 5 or > 95) and during warm-up — a fresh window must
//    not speculate.

/** Standard normal CDF via the Abramowitz–Stegun erf approximation (|ε| < 1.5e-7). */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erf =
    1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-z * z) / 2)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/** Risk in whole percent (5..95, steps of 5), or undefined when it would be
 *  noise: no burn yet, already exhausted, or a near-certain answer either way
 *  (the verdict line owns those). */
export function runOutRisk(usedPct: number, burnRatePctPerHour: number, hoursToReset: number): number | undefined {
  if (usedPct >= 100 || burnRatePctPerHour <= 0 || hoursToReset <= 0) return undefined
  const expectedBurn = burnRatePctPerHour * hoursToReset
  const z = (100 - usedPct - expectedBurn) / (0.5 * expectedBurn)
  const p = Math.round(((1 - phi(z)) * 100) / 5) * 5
  return p >= 5 && p <= 95 ? p : undefined
}

/** THE risk wording — one spelling, appended (never mixed into) the verdict line. */
export function formatRisk(runOutRiskPct: number): string {
  return `≈${runOutRiskPct}% run-out risk`
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
