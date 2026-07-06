import type { AgentProfile, PlanUsageView, UsageAlert, UsageAlertConfig } from '@contracts'

// Threshold alerts (Phase-7/09): evaluate each GOOD plan's PRIMARY window
// against the configured shoulder-taps (quiet 80 / warn 95 by default) and
// emit house-toast copy. Single-fire is the contract: state is keyed
// (provider, profile) with the WINDOW EPOCH inside — persisted in the same KV
// as other app state, so a restart never re-fires a spent threshold. A new
// epoch (the window reset) re-arms everything and emits one quiet "fresh
// window" alert. Copy is composed HERE, once — the warning body is the 7/02
// formatter's verdict line VERBATIM; the renderer never re-spells a word.

export interface ThresholdKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

interface ThrState {
  epoch: string
  fired: number[]
}

const stateKey = (providerId: string, profileId: string): string => `usage.thr.${providerId}.${profileId}`

function readState(kv: ThresholdKv, key: string): ThrState | null {
  const raw = kv.get(key)
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as ThrState
    return o && typeof o.epoch === 'string' && Array.isArray(o.fired) ? o : null
  } catch {
    return null
  }
}

/** The 7/09 failover-feed condition: the ACTIVE lane (order-0 profile) crossed
 *  `warn` AND a sibling profile on the same provider sits under 50% on its
 *  primary window. Returns the best sibling (lowest usage) — a SUGGESTION the
 *  human acts on, never an auto-switch (the gate philosophy). */
export function suggestFailover(
  plan: PlanUsageView,
  plans: PlanUsageView[],
  profiles: AgentProfile[]
): { profileId: string; profileName: string } | null {
  const mine = profiles.filter((p) => p.provider === plan.providerId).sort((a, b) => a.order - b.order)
  if (mine.length < 2) return null
  if (mine[0].id !== plan.profileId) return null // only the ACTIVE plan suggests a lane change
  const sibling = plans
    .filter(
      (o) =>
        o.providerId === plan.providerId &&
        o.profileId !== plan.profileId &&
        o.health === 'fresh' &&
        !!o.windows[0] &&
        o.windows[0].usedPct < 50 &&
        mine.some((m) => m.id === o.profileId)
    )
    .sort((a, b) => a.windows[0].usedPct - b.windows[0].usedPct)[0]
  if (!sibling) return null
  const prof = mine.find((m) => m.id === sibling.profileId)
  return prof ? { profileId: prof.id, profileName: prof.name } : null
}

/** Evaluate one enriched snapshot. Call on every poller push; the KV state
 *  makes it idempotent — an unchanged snapshot emits nothing. */
export function evaluateThresholds(
  plans: PlanUsageView[],
  cfg: UsageAlertConfig,
  profiles: AgentProfile[],
  kv: ThresholdKv
): UsageAlert[] {
  const alerts: UsageAlert[] = []
  for (const p of plans) {
    if (p.health !== 'fresh') continue // stale is old data, never a new tap
    const w = p.windows[0] // the primary (session) lane thresholds watch
    if (!w) continue
    const epoch = w.resetsAt ?? 'static' // rolling windows never re-arm (no reset exists)
    const key = stateKey(p.providerId, p.profileId)
    let state = readState(kv, key)
    if (state && state.epoch !== epoch) {
      // The window rolled over: ONE quiet "fresh window" + full re-arm.
      alerts.push({
        kind: 'reset',
        providerId: p.providerId,
        profileId: p.profileId,
        planLabel: p.planLabel,
        windowLabel: w.label,
        usedPct: Math.round(w.usedPct),
        title: `${p.planLabel} — fresh ${w.label} window`,
        body: 'Counters reset — a full window ahead.'
      })
      state = { epoch, fired: [] }
      kv.set(key, JSON.stringify(state))
    } else if (!state) {
      state = { epoch, fired: [] } // first sight of this lane: arm silently
      kv.set(key, JSON.stringify(state))
    }
    const levels = (
      [
        { pct: cfg.quiet, level: 'quiet' },
        { pct: cfg.warn, level: 'warn' }
      ] as { pct: number; level: 'quiet' | 'warn' }[]
    )
      .filter((l) => l.pct > 0 && l.pct <= 100)
      .sort((a, b) => a.pct - b.pct)
    const crossed = levels.filter((l) => w.usedPct >= l.pct && !state.fired.includes(l.pct))
    if (!crossed.length) continue
    // One toast per tick: the HIGHEST new crossing speaks; every crossed
    // level is spent (a 0->97 jump costs one warning, not a stack).
    const top = crossed[crossed.length - 1]
    state.fired.push(...crossed.map((l) => l.pct))
    kv.set(key, JSON.stringify(state))
    const alert: UsageAlert = {
      kind: 'threshold',
      level: top.level,
      providerId: p.providerId,
      profileId: p.profileId,
      planLabel: p.planLabel,
      windowLabel: w.label,
      usedPct: Math.round(w.usedPct),
      title: `${p.planLabel} — ${top.pct}% of ${w.label} used`,
      // THE verdict line, verbatim — or a plain state line when unpaceable.
      body: p.pace?.text ?? `${Math.round(w.usedPct)}% of ${w.label} used`
    }
    if (top.level === 'warn') {
      const failover = suggestFailover(p, plans, profiles)
      if (failover) alert.failover = failover
    }
    alerts.push(alert)
  }
  return alerts
}
