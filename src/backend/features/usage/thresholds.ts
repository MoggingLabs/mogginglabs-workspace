import type { AgentProfile, PaceView, PlanUsageView, UsageAlert, UsageAlertConfig, WindowView } from '@contracts'

// Threshold alerts (Phase-7/09, rebuilt phase-11 after the root-cause audit —
// prompts/phase-11/USAGE-ALERTS-ROOT-CAUSE.md). The engine walks EVERY window
// of every fresh plan (the windows[0]-only rule silenced the weekly lanes),
// plus a credits floor and a spend cap — the shapes half the catalog actually
// has. Copy is composed HERE, once; the renderer never re-spells a word.
//
// Two rules replace the old window-epoch identity, both taken from the
// reference implementation (steipete/CodexBar, studied 2026-07-15):
//
//   PRUNE-ON-DESCENT (their `thresholdsToClear`): a fired level un-fires the
//   moment usage falls back below it (minus hysteresis). Resets, top-ups and
//   account swaps all re-arm by themselves — there is no identity string to
//   get wrong, and a lane can warn again next window without special cases.
//
//   BOUNDARY TOLERANCE (their `areEquivalentPlanUtilizationResetBoundaries`):
//   Anthropic recomputes `resets_at` per request, so two samples of the SAME
//   window carry slightly different strings. Boundaries within 2 minutes are
//   the same window; a rollover requires the boundary to ADVANCE beyond the
//   tolerance; a REGRESSED boundary is a stale sample and skips the lane.

export interface ThresholdKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** Boundaries closer than this are the same window (resets_at churn). */
const BOUNDARY_TOLERANCE_MS = 2 * 60_000
/** A fired level survives until usage falls this many points below it, so
 *  rounding jitter at the exact threshold cannot re-fire it. */
const REARM_MARGIN_PCT = 5
/** A spent credits floor re-arms only after a real top-up, not on jitter. */
const CREDITS_REARM_FACTOR = 1.25

interface LaneState {
  /** Last accepted reset boundary (ISO). Rolls forward with in-tolerance drift. */
  boundary?: string
  fired: number[]
  paceFired?: boolean
  /** Last usedPct seen — a MATERIAL descent (reset we never witnessed, top-up)
   *  re-arms the pace tap, which fired-level pruning alone cannot see when no
   *  level had fired yet. */
  lastPct?: number
}
interface ThrState {
  v: 2
  lanes: Record<string, LaneState>
  credits?: { fired: boolean }
  spend?: { fired: number[]; month: string }
}
/** The pre-audit shape: one implicit lane (windows[0]), raw-string epoch. */
interface LegacyThrState {
  epoch: string
  fired: number[]
  paceFired?: boolean
}

const stateKey = (providerId: string, profileId: string): string => `usage.thr.${providerId}.${profileId}`

function parseState(raw: string | null): ThrState | LegacyThrState | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as ThrState | LegacyThrState
    if (o && typeof o === 'object' && (o as ThrState).v === 2 && (o as ThrState).lanes) return o
    if (o && typeof (o as LegacyThrState).epoch === 'string' && Array.isArray((o as LegacyThrState).fired)) return o
    return null
  } catch {
    return null
  }
}

/** Read state for (provider, profile), migrating the two legacy shapes:
 *  the v1 blob becomes the primary lane's state, and a `login-<provider>`
 *  lane with no state ADOPTS `default`'s — login auto-discovery renames the
 *  lane minutes after first launch, and the rename must not re-fire every
 *  threshold the user was already shown. */
function readState(kv: ThresholdKv, providerId: string, profileId: string, primaryLabel: string | null): ThrState {
  let parsed = parseState(kv.get(stateKey(providerId, profileId)))
  if (!parsed && profileId === `login-${providerId}`) {
    parsed = parseState(kv.get(stateKey(providerId, 'default')))
  }
  if (!parsed) return { v: 2, lanes: {} }
  if ((parsed as ThrState).v === 2) return parsed as ThrState
  const legacy = parsed as LegacyThrState
  const lane: LaneState = { fired: legacy.fired, ...(legacy.paceFired ? { paceFired: true } : {}) }
  if (legacy.epoch !== 'static') lane.boundary = legacy.epoch
  return { v: 2, lanes: primaryLabel ? { [primaryLabel]: lane } : {} }
}

/** The pace of the window this alert NAMES — each window paces itself; the
 *  plan-level view is a fallback only when there is nothing to confuse. */
const paceOf = (p: PlanUsageView, w: WindowView): PaceView | undefined =>
  w.pace ?? (p.windows.length <= 1 ? p.pace : undefined)

/** The 7/09 failover-feed condition, now judged on the sibling's WORST window
 *  — the old windows[0] rule offered switches onto weekly-exhausted accounts. */
export function suggestFailover(
  plan: PlanUsageView,
  plans: PlanUsageView[],
  profiles: AgentProfile[]
): { profileId: string; profileName: string } | null {
  const mine = profiles.filter((p) => p.provider === plan.providerId).sort((a, b) => a.order - b.order)
  if (mine.length < 2) return null
  if (mine[0].id !== plan.profileId) return null // only the ACTIVE plan suggests a lane change
  const worstPct = (o: PlanUsageView): number => Math.max(...o.windows.map((w) => w.usedPct))
  const sibling = plans
    .filter(
      (o) =>
        o.providerId === plan.providerId &&
        o.profileId !== plan.profileId &&
        o.health === 'fresh' &&
        o.windows.length > 0 &&
        worstPct(o) < 50 &&
        mine.some((m) => m.id === o.profileId)
    )
    .sort((a, b) => worstPct(a) - worstPct(b))[0]
  if (!sibling) return null
  const prof = mine.find((m) => m.id === sibling.profileId)
  return prof ? { profileId: prof.id, profileName: prof.name } : null
}

const activeLevels = (cfg: UsageAlertConfig): { pct: number; level: 'quiet' | 'warn' }[] =>
  (
    [
      { pct: cfg.quiet, level: 'quiet' },
      { pct: cfg.warn, level: 'warn' }
    ] as { pct: number; level: 'quiet' | 'warn' }[]
  )
    .filter((l) => l.pct > 0 && l.pct <= 100)
    .sort((a, b) => a.pct - b.pct)

const money = (amount: number, currency: string): string =>
  currency === 'USD' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`

/** Evaluate one enriched snapshot. Idempotent per KV state; call on every
 *  poller push — an unchanged snapshot emits nothing. */
export function evaluateThresholds(
  plans: PlanUsageView[],
  cfg: UsageAlertConfig,
  profiles: AgentProfile[],
  kv: ThresholdKv,
  now: number = Date.now()
): UsageAlert[] {
  const alerts: UsageAlert[] = []
  const levels = activeLevels(cfg)
  for (const p of plans) {
    if (p.health !== 'fresh') continue // stale is old data, never a new tap
    const state = readState(kv, p.providerId, p.profileId, p.windows[0]?.label ?? null)
    let dirty = false

    for (const w of p.windows) {
      // A lane whose reset has PASSED is old data however 'fresh' the snapshot
      // (a local-file reader honestly serves the last rollout it found). Skip
      // THIS lane only — the old rule silenced the whole plan, so a lapsed 5h
      // window muted a weekly sitting at 99%.
      if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue
      const lane: LaneState = state.lanes[w.label] ?? { fired: [] }
      const pct = w.usedPct
      let rolledOver = false
      let priorFired = 0

      if (w.resetsAt) {
        const stored = lane.boundary ? Date.parse(lane.boundary) : NaN
        const seen = Date.parse(w.resetsAt)
        if (Number.isFinite(stored) && Number.isFinite(seen)) {
          const delta = seen - stored
          if (delta > BOUNDARY_TOLERANCE_MS) {
            // A real rollover: the boundary ADVANCED. Re-arm the lane.
            rolledOver = true
            priorFired = lane.fired.length
            lane.fired = []
            lane.paceFired = false
          } else if (delta < -BOUNDARY_TOLERANCE_MS) {
            continue // boundary regressed = a stale sample; keep state, say nothing
          }
          // In-tolerance drift is the SAME window: roll the stored boundary
          // forward so drift can never accumulate past the tolerance.
        }
        lane.boundary = w.resetsAt
      }

      // Prune-on-descent: usage fell back below a fired level (reset we never
      // witnessed, top-up, account swap) — the level re-arms itself. The
      // margin keeps jitter at the exact threshold from cycling fire/prune.
      const kept = lane.fired.filter((l) => pct > l - REARM_MARGIN_PCT)
      if (kept.length !== lane.fired.length) {
        lane.fired = kept
        lane.paceFired = false
      }
      if (lane.lastPct !== undefined && pct < lane.lastPct - REARM_MARGIN_PCT) lane.paceFired = false

      const pace = paceOf(p, w)
      const crossed = levels.filter((l) => pct >= l.pct && !lane.fired.includes(l.pct))
      if (crossed.length) {
        // One toast per lane per tick: the loudest level sets severity, the
        // TITLE names the actual reading (a user at 100% must not be told
        // "95% used"), and every crossed level is spent at once.
        const level = crossed.some((l) => l.level === 'warn') ? 'warn' : 'quiet'
        lane.fired.push(...crossed.map((l) => l.pct))
        if (pace?.verdict === 'runs-out') lane.paceFired = true
        const alert: UsageAlert = {
          kind: 'threshold',
          level,
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: w.label,
          usedPct: Math.round(pct),
          title: `${p.planLabel} — ${Math.round(pct)}% of ${w.label} used`,
          body: pace?.text ?? `${Math.round(pct)}% of ${w.label} used`
        }
        if (level === 'warn') {
          const failover = suggestFailover(p, plans, profiles)
          if (failover) alert.failover = failover
        }
        alerts.push(alert)
      } else if (rolledOver && priorFired > 0) {
        // The window rolled over on a lane the user had been warned about —
        // that is news. (A rollover nobody was warned about is not; and a
        // rollover that lands ALREADY past a threshold speaks with the
        // crossing's voice above, never both.)
        alerts.push({
          kind: 'reset',
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: w.label,
          usedPct: Math.round(pct),
          title: `${p.planLabel} — fresh ${w.label} window`,
          body: 'Counters reset — a full window ahead.'
        })
      } else if (pace?.verdict === 'runs-out' && !lane.paceFired && pct < cfg.warn) {
        // The PREDICTIVE tap: the projection flipped to runs-out while usage
        // sits under every threshold. A forecast is not a missed crossing, so
        // it fires on first sight — once per window (paceFired clears on
        // rollover and on prune).
        lane.paceFired = true
        alerts.push({
          kind: 'pace',
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: w.label,
          usedPct: Math.round(pct),
          title: `${p.planLabel} — on track to run out before reset`,
          body: pace.text
        })
      }

      lane.lastPct = pct
      state.lanes[w.label] = lane
      dirty = true
    }

    // ── The credits floor: the shape ~20 catalog rows actually have. A
    // balance has no denominator, so "low" is the user's number, not ours —
    // no floor configured (0/absent) means no tap, honestly.
    const floor = cfg.floors?.[p.providerId] ?? 0
    if (p.credits && floor > 0) {
      const cst = state.credits ?? { fired: false }
      if (cst.fired && p.credits.remaining >= floor * CREDITS_REARM_FACTOR) cst.fired = false // a real top-up re-arms
      if (!cst.fired && p.credits.remaining <= floor) {
        cst.fired = true
        alerts.push({
          kind: 'threshold',
          level: 'warn',
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: p.credits.label,
          usedPct: 0,
          title: `${p.planLabel} — ${p.credits.remaining} ${p.credits.label} left`,
          body: `Below your ${floor} ${p.credits.label} floor.`
        })
      }
      state.credits = cst
      dirty = true
    }

    // ── The spend cap (Claude's extra-usage overage; admin spend rows): a
    // real amount against a real limit is a percentage — the quiet/warn pcts
    // apply as-is. The month is the epoch; the title names MONEY.
    if (p.spend?.limit && p.spend.limit > 0) {
      const month = new Date(now).toISOString().slice(0, 7)
      let sst = state.spend ?? { fired: [], month }
      if (sst.month !== month) sst = { fired: [], month } // billing month rolled
      const spendPct = (p.spend.amount / p.spend.limit) * 100
      const keptSpend = sst.fired.filter((l) => spendPct > l - REARM_MARGIN_PCT)
      if (keptSpend.length !== sst.fired.length) sst.fired = keptSpend
      const crossedSpend = levels.filter((l) => spendPct >= l.pct && !sst.fired.includes(l.pct))
      if (crossedSpend.length) {
        sst.fired.push(...crossedSpend.map((l) => l.pct))
        alerts.push({
          kind: 'threshold',
          level: crossedSpend.some((l) => l.level === 'warn') ? 'warn' : 'quiet',
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: 'spend',
          usedPct: Math.round(spendPct),
          title: `${p.planLabel} — ${money(p.spend.amount, p.spend.currency)} of ${money(p.spend.limit, p.spend.currency)} used`,
          body: `${Math.round(spendPct)}% of the ${p.spend.currency === 'USD' ? '$' : ''}${p.spend.limit} cap.`
        })
      }
      state.spend = sst
      dirty = true
    }

    if (dirty) kv.set(stateKey(p.providerId, p.profileId), JSON.stringify(state))
  }
  return alerts
}
