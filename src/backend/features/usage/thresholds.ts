import type { AgentProfile, PaceView, PlanUsageView, UsageAlert, UsageAlertConfig, WindowView } from '@contracts'

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
  /** The predictive runs-out tap — once per window epoch, like the pcts. */
  paceFired?: boolean
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

/** The pace of the window this alert NAMES. A plan's own `pace` is the WORST
 *  window's (main ranks by severity), so on a multi-lane plan it can be the
 *  WEEKLY forecast — which the alert would then present as the session's, under
 *  the session's label and pct. A single-window plan has just the one pace, so
 *  there the plan-level view IS the window's (and hand-built views carry only
 *  that one). */
const paceOf = (p: PlanUsageView, w: WindowView): PaceView | undefined =>
  w.pace ?? (p.windows.length <= 1 ? p.pace : undefined)

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
  kv: ThresholdKv,
  now: number = Date.now()
): UsageAlert[] {
  const alerts: UsageAlert[] = []
  for (const p of plans) {
    if (p.health !== 'fresh') continue // stale is old data, never a new tap
    const w = p.windows[0] // the primary (session) lane thresholds watch
    if (!w) continue
    // A window whose reset has PASSED is old data too, however 'fresh' the
    // snapshot: a local-file reader (Codex) honestly serves the last rollout it
    // found — so drive the session to 85%, quit, come back six hours later, and
    // that is still a live-looking 85% of a window which closed while the CLI was
    // shut. Tapping the shoulder for it warns about usage the user no longer has.
    // The next real sample carries the new epoch and re-arms everything.
    if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue
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
    const pace = paceOf(p, w) // the forecast for THIS window — never a sibling's
    const levels = (
      [
        { pct: cfg.quiet, level: 'quiet' },
        { pct: cfg.warn, level: 'warn' }
      ] as { pct: number; level: 'quiet' | 'warn' }[]
    )
      .filter((l) => l.pct > 0 && l.pct <= 100)
      .sort((a, b) => a.pct - b.pct)
    const crossed = levels.filter((l) => w.usedPct >= l.pct && !state.fired.includes(l.pct))
    if (!crossed.length) {
      // ── The PREDICTIVE tap (CodexBar's pace warning): the projection flipped
      // to runs-out while usage sits UNDER every threshold — "you'll hit the
      // wall before reset", possibly at 60%. Once per window epoch. A forecast
      // is not a missed crossing, so (unlike the pcts) it fires on first sight;
      // and it always YIELDS to a same-tick threshold toast, whose body already
      // carries this exact verdict line — one lane, one voice per tick.
      if (pace?.verdict === 'runs-out' && !state.paceFired && w.usedPct < cfg.warn) {
        state.paceFired = true
        kv.set(key, JSON.stringify(state))
        alerts.push({
          kind: 'pace',
          providerId: p.providerId,
          profileId: p.profileId,
          planLabel: p.planLabel,
          windowLabel: w.label,
          usedPct: Math.round(w.usedPct),
          title: `${p.planLabel} — on track to run out before reset`,
          body: pace.text
        })
      }
      continue
    }
    // One toast per tick: the HIGHEST new crossing names the pct; every crossed
    // level is spent (a 0->97 jump costs one warning, not a stack). SEVERITY is
    // the loudest level crossed, not the level that happens to sit highest on
    // the scale — a user who saves quiet=95/warn=80 has an odd config, not a
    // demoted emergency (that ordering used to whisper the crossing AND silence
    // the failover suggestion, which reads `warn`).
    const top = crossed[crossed.length - 1]
    const level = crossed.some((l) => l.level === 'warn') ? 'warn' : 'quiet'
    state.fired.push(...crossed.map((l) => l.pct))
    // A threshold toast whose body IS the runs-out verdict has delivered the
    // predictive message too — the pace tap is spent with it.
    if (pace?.verdict === 'runs-out') state.paceFired = true
    kv.set(key, JSON.stringify(state))
    const alert: UsageAlert = {
      kind: 'threshold',
      level,
      providerId: p.providerId,
      profileId: p.profileId,
      planLabel: p.planLabel,
      windowLabel: w.label,
      usedPct: Math.round(w.usedPct),
      title: `${p.planLabel} — ${top.pct}% of ${w.label} used`,
      // THE verdict line, verbatim — or a plain state line when unpaceable.
      body: pace?.text ?? `${Math.round(w.usedPct)}% of ${w.label} used`
    }
    if (level === 'warn') {
      const failover = suggestFailover(p, plans, profiles)
      if (failover) alert.failover = failover
    }
    alerts.push(alert)
  }
  return alerts
}
