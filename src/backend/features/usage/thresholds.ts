import type { AgentProfile, PaceView, PlanUsageView, UsageAlert, UsageAlertConfig, WindowView } from '@contracts'
import { RESET_BOUNDARY_TOLERANCE_MS, displayPct, windowLiveness } from '@contracts'
import { laneKey } from './lane-key'

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

/** Boundaries closer than this are the same window (resets_at churn). Lives in
 *  @contracts so the renderer's offer planner uses the SAME number. */
const BOUNDARY_TOLERANCE_MS = RESET_BOUNDARY_TOLERANCE_MS
/** A fired level survives until usage falls this many points below it, so
 *  rounding jitter at the exact threshold cannot re-fire it. */
const REARM_MARGIN_PCT = 5
/** A spent credits floor re-arms only after a real top-up, not on jitter. */
const CREDITS_REARM_FACTOR = 1.25
/** A lane nobody has served for this long is gone — a dropped model lane, a
 *  provider that changed shape. Comfortably longer than any window we meter
 *  (the longest is monthly), so a lane that merely went quiet is never dropped.
 *  Pruning is safe ONLY because of the safety net above: a wrongly pruned lane
 *  comes back UNKNOWN, and unknown cannot fire `capped`. Without that net this
 *  eviction would itself be a way to cover every pane. */
const LANE_TTL_MS = 45 * 86_400_000

interface LaneState {
  /** Last accepted reset boundary (ISO). Rolls forward with in-tolerance drift. */
  boundary?: string
  fired: number[]
  paceFired?: boolean
  /** Last usedPct seen — a MATERIAL descent (reset we never witnessed, top-up)
   *  re-arms the pace tap, which fired-level pruning alone cannot see when no
   *  level had fired yet. */
  lastPct?: number
  /** Epoch ms of the last evaluation that touched this lane — the ONLY input to
   *  age pruning. Absent = written before this field existed; stamped on first
   *  touch and never pruned until it has a date. */
  at?: number
}
interface ThrState {
  v: 2
  lanes: Record<string, LaneState>
  credits?: { fired: boolean }
  spend?: { fired: number[]; month: string }
  /** Set on the SOURCE key when another profile id adopted this state, so a
   *  second profile cannot inherit the same history. A tombstone is a WRITE
   *  because this KV has no delete (see `adoptFrom`). */
  adoptedBy?: string
}
/** The pre-audit shape: one implicit lane (windows[0]), raw-string epoch. */
interface LegacyThrState {
  epoch: string
  fired: number[]
  paceFired?: boolean
}

const stateKey = (providerId: string, profileId: string): string => `usage.thr.${providerId}.${profileId}`

/** Resolve a lane's stored state under its stable ID, falling back ONCE to the
 *  LABEL key that pre-id builds wrote, and PROMOTING it so the alias retires
 *  itself after one poll.
 *
 *  `known` is the crux, and the reason this returns a pair instead of a lane:
 *  a MISS here is not a neutral default. An empty lane crosses every level at
 *  once, and at 100 that is `capped` — a pane-covering offer with a failover
 *  suggestion, on a lane that never descended. So a miss is reported as a miss,
 *  and the caller withholds `capped` rather than inventing evidence.
 *
 *  Read-through rather than a one-shot rewrite because `SettingsStore` is
 *  get/set only — there is no way to enumerate `usage.thr.*`, so a boot-time
 *  sweep would have to GUESS the (provider, profile, label) tuples it should
 *  migrate. Guessing is the defect. This touches only lanes actually evaluated,
 *  so it cannot invent state for a lane that no longer exists. */
function adoptLane(state: ThrState, id: string, label: string): { lane: LaneState; known: boolean } {
  const byId = state.lanes[id]
  if (byId) return { lane: byId, known: true }
  const byLabel = state.lanes[label]
  if (byLabel) {
    state.lanes[id] = byLabel
    delete state.lanes[label] // the only delete this KV allows: inside the value
    return { lane: byLabel, known: true }
  }
  return { lane: { fired: [] }, known: false }
}

/** May this profile inherit the `'default'` pseudo-lane's history?
 *
 *  Only when it is the SAME ACCOUNT under a new name. The seam mints `'default'`
 *  when no profile targets a provider (backend/features/usage/index.ts), and
 *  that lane resolves the CLI's own config home. The first profile per provider
 *  is created with `env = {}` (src/main/profile-rules.ts) — the same home — so
 *  when one appears, `'default'` really was it all along. Login discovery does
 *  the same thing under the name `login-<provider>`.
 *
 *  Every OTHER profile points at `~/.<provider>-<slug>`: a different account,
 *  whose history this is not. Letting any state-less profile adopt would be
 *  worse than a re-fire — it silences thresholds that profile never crossed,
 *  AND the one-shot tombstone would strip the history from its real owner. */
const mayAdoptDefault = (providerId: string, profileId: string, orderZeroId: string | undefined): boolean =>
  profileId !== 'default' && (profileId === orderZeroId || profileId === `login-${providerId}`)

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

/** Read state for (provider, profile), migrating the two legacy shapes: the v1
 *  blob becomes the primary lane's state, and a profile with NO state of its
 *  own ADOPTS an earlier id's (see `adoptFrom`) — an id rename must not re-fire
 *  every threshold the user was already shown.
 *
 *  Adoption is ONE-SHOT: the source is tombstoned, so two profiles created at
 *  once cannot both inherit the same history. `v` is deliberately NOT bumped
 *  when the lane keys change — the blob's SHAPE is identical and only the keys
 *  inside `lanes` move, so a version branch would add nothing but a new way for
 *  a valid blob to be REJECTED. A rejected blob reads as an empty one, and an
 *  empty one is the false `capped` this whole change exists to stop. */
function readState(
  kv: ThresholdKv,
  providerId: string,
  profileId: string,
  primaryLabel: string | null,
  orderZeroId: string | undefined
): ThrState {
  let parsed = parseState(kv.get(stateKey(providerId, profileId)))
  if (!parsed && mayAdoptDefault(providerId, profileId, orderZeroId)) {
    const from = parseState(kv.get(stateKey(providerId, 'default')))
    // `adoptedBy` on the source means someone already took this history — so
    // two profiles created at once cannot both inherit it.
    if (from && !(from as ThrState).adoptedBy) {
      parsed = from
      // A tombstone is a WRITE because this KV has no delete.
      kv.set(stateKey(providerId, 'default'), JSON.stringify({ v: 2, lanes: {}, adoptedBy: profileId } satisfies ThrState))
    }
  }
  if (!parsed) return { v: 2, lanes: {} }
  if ((parsed as ThrState).v === 2) return parsed as ThrState
  const legacy = parsed as LegacyThrState
  const lane: LaneState = { fired: legacy.fired, ...(legacy.paceFired ? { paceFired: true } : {}) }
  if (legacy.epoch !== 'static') lane.boundary = legacy.epoch
  // The v1 blob only ever described ONE lane, so only the primary can inherit
  // it. Every other lane of this plan comes back unknown — which under the
  // safety net means silent, not `capped`. That is the whole point of the net:
  // this migration used to re-fire every non-primary lane already at 100%.
  return { v: 2, lanes: primaryLabel ? { [primaryLabel]: lane } : {} }
}

/** The pace of the window this alert NAMES — each window paces itself; the
 *  plan-level view is a fallback only when there is nothing to confuse. */
const paceOf = (p: PlanUsageView, w: WindowView): PaceView | undefined =>
  w.pace ?? (p.windows.length <= 1 ? p.pace : undefined)

/** The 7/09 failover-feed condition, now judged on the sibling's WORST window
 *  — the old windows[0] rule offered switches onto weekly-exhausted accounts.
 *  Judged on LIVE windows only: a window whose `resetsAt` has passed is old
 *  data however fresh the snapshot (the alert engine skips those lanes at its
 *  own loop for the same reason), and scoring it pinned a sibling at its
 *  pre-reset percentage — suppressing the suggestion exactly when that lane
 *  had just become the best one. A sibling with NO live window says nothing
 *  about itself and is excluded, not trusted. */
export function suggestFailover(
  plan: PlanUsageView,
  plans: PlanUsageView[],
  profiles: AgentProfile[],
  now: number
): { profileId: string; profileName: string } | null {
  const mine = profiles.filter((p) => p.provider === plan.providerId).sort((a, b) => a.order - b.order)
  if (mine.length < 2) return null
  if (mine[0].id !== plan.profileId) return null // only the ACTIVE plan suggests a lane change
  const liveWindows = (o: PlanUsageView): WindowView[] => o.windows.filter((w) => windowLiveness(w, now) === 'live')
  // No live window = nothing known about this sibling. `Math.max()` of an empty
  // list is -Infinity, which would read as "completely idle" and make an
  // unreadable account the BEST suggestion; +Infinity refuses instead. The
  // caller also filters on `liveWindows.length > 0`, so this is the belt to
  // that brace — a totality the expression should not depend on someone else for.
  const worstPct = (o: PlanUsageView): number => {
    const live = liveWindows(o)
    return live.length ? Math.max(...live.map((w) => w.usedPct)) : Number.POSITIVE_INFINITY
  }
  const sibling = plans
    .filter(
      (o) =>
        o.providerId === plan.providerId &&
        o.profileId !== plan.profileId &&
        o.health === 'fresh' &&
        liveWindows(o).length > 0 &&
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
  // The window ladder adds `capped` at 100 — "the lane is spent NOW", the
  // pane-failover trigger, distinct from warn's "almost". A user level set at
  // exactly 100 is superseded (never two alerts for one crossing). The spend
  // block below deliberately keeps the plain quiet/warn ladder: a spend cap is
  // a billing fact, not a lane another profile could continue.
  const laneLevels: { pct: number; level: 'quiet' | 'warn' | 'capped' }[] = [
    ...levels.filter((l) => l.pct < 100),
    { pct: 100, level: 'capped' }
  ]
  for (const p of plans) {
    if (p.health !== 'fresh') continue // stale is old data, never a new tap
    const orderZeroId = profiles
      .filter((x) => x.provider === p.providerId)
      .sort((x, y) => x.order - y.order)[0]?.id
    const state = readState(kv, p.providerId, p.profileId, p.windows[0]?.label ?? null, orderZeroId)
    let dirty = false

    for (const w of p.windows) {
      // A lane whose reset has PASSED is old data however 'fresh' the snapshot
      // (a local-file reader honestly serves the last rollout it found). Skip
      // THIS lane only — the old rule silenced the whole plan, so a lapsed 5h
      // window muted a weekly sitting at 99%.
      const liveness = windowLiveness(w, now)
      if (liveness === 'lapsed') continue
      // A reading that is not a number is not a reading. It used to reach the
      // ladder, where every `>=` is false — silent by luck, not by rule.
      if (!Number.isFinite(w.usedPct)) continue
      // Keyed by the lane's stable IDENTITY, not its label. A label is prose
      // the provider rewrites (`seven_day_opus` -> `seven_day_fable`), and each
      // rewrite orphaned the stored lane — which read as a lane with no history,
      // which crosses every level at once, which at 100 is `capped`.
      // `known` = this state came OUT of the store; a miss is reported as a miss
      // rather than defaulted, because the default is what fires the offer.
      const key = laneKey(w)
      const { lane, known } = adoptLane(state, key, w.label)
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
        // Only store a boundary we could READ. An unparseable string used to be
        // stored anyway, and from then on `Number.isFinite(stored)` was false
        // forever — so that lane could never detect its own rollover and never
        // re-armed. A boundary we cannot date is not a boundary.
        if (liveness === 'live') lane.boundary = w.resetsAt
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
      const crossed = laneLevels.filter((l) => pct >= l.pct && !lane.fired.includes(l.pct))
      if (crossed.length) {
        // One toast per lane per tick: the loudest level sets severity, the
        // TITLE names the actual reading (a user at 100% must not be told
        // "95% used"), and every crossed level is spent at once — a 60→100
        // jump crosses quiet, warn AND capped in one tick and speaks once,
        // with capped's voice.
        //
        // THE SAFETY NET. `capped` is the only level that covers a pane and
        // blocks typing, so it demands more than a number: the lane must be one
        // we have SEEN before (`known`) and its window must be datable and
        // current (`live`). Every way this engine could invent a cap runs
        // through "the lane looks new" — a provider renaming its label, a
        // profile id changing, the v1 blob seeding only the primary lane, a
        // pruned entry, a fresh settings DB. All of them now degrade to warn's
        // voice, which keeps the failover suggestion, so the user is still told
        // and still offered the switch — just not by an overlay that asserts a
        // fact nobody checked.
        //
        // The one case that loses: a lane whose very first sample ever is >=100.
        // That ascent was never witnessed, and an unwitnessed ascent is exactly
        // what a replayed or migrated state looks like. Costs a toast instead of
        // an overlay, once, until the next rollover.
        const canCap = known && liveness === 'live'
        const level = crossed.some((l) => l.level === 'capped') && canCap
          ? 'capped'
          : crossed.some((l) => l.level === 'capped' || l.level === 'warn')
            ? 'warn'
            : 'quiet'
        // Spent either way — a suppressed cap must not become a repeating warn.
        lane.fired.push(...crossed.map((l) => l.pct))
        if (pace?.verdict === 'runs-out') lane.paceFired = true
        const alert: UsageAlert = {
          kind: 'threshold',
          level,
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: w.label,
          // The window this alert is ABOUT, so delivery can tell when the news
          // has outlived its subject (see the outbox's expiry rule).
          ...(w.resetsAt && liveness === 'live' ? { resetsAt: w.resetsAt } : {}),
          usedPct: displayPct(pct),
          title:
            level === 'capped'
              ? `${p.planLabel} — usage limit reached (${w.label})`
              : `${p.planLabel} — ${displayPct(pct)}% of ${w.label} used`,
          body: pace?.text ?? `${displayPct(pct)}% of ${w.label} used`
        }
        if (level === 'warn' || level === 'capped') {
          const failover = suggestFailover(p, plans, profiles, now)
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
          ...(w.resetsAt && liveness === 'live' ? { resetsAt: w.resetsAt } : {}),
          usedPct: displayPct(pct),
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
          ...(w.resetsAt && liveness === 'live' ? { resetsAt: w.resetsAt } : {}),
          usedPct: displayPct(pct),
          title: `${p.planLabel} — on track to run out before reset`,
          body: pace.text
        })
      }

      lane.lastPct = pct
      lane.at = now
      state.lanes[key] = lane
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
          usedPct: displayPct(spendPct),
          title: `${p.planLabel} — ${money(p.spend.amount, p.spend.currency)} of ${money(p.spend.limit, p.spend.currency)} used`,
          body: `${displayPct(spendPct)}% of the ${p.spend.currency === 'USD' ? '$' : ''}${p.spend.limit} cap.`
        })
      }
      state.spend = sst
      dirty = true
    }

    if (dirty) {
      // Evict lanes nobody has served in a very long time. `state.lanes` only
      // ever GAINED keys before this, so every renamed or dropped lane stayed
      // forever. Only dated entries are eligible — an undated one is pre-stamp
      // state, and guessing its age is exactly the kind of guess this file is
      // being cured of.
      for (const [k, l] of Object.entries(state.lanes)) {
        if (typeof l.at === 'number' && now - l.at > LANE_TTL_MS) delete state.lanes[k]
      }
      kv.set(stateKey(p.providerId, p.profileId), JSON.stringify(state))
    }
  }
  return alerts
}
