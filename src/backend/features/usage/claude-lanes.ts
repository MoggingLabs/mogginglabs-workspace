import type { UsageWindow } from '@contracts'

// Claude's usage-endpoint body -> normalized lanes. Lifted OUT of
// claude-adapter.ts so this logic can be unit-tested: the adapter imports
// claude-refresh, which imports platform/pty-host, which loads the native pty
// binding at module scope — so no vitest file can import the adapter, and the
// lane parsing (the part that decides what a "lane" IS, and therefore what can
// fire a usage alert) was smoke-only. Pure: no I/O, no credentials, no clock.

const SESSION_MS = 5 * 3_600_000
const WEEK_MS = 7 * 86_400_000

export const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// ── Lane discovery is DYNAMIC, never a hardcoded model list. The endpoint's
// model-specific weekly lane has already changed name twice (seven_day_opus
// in the Opus era; seven_day_fable today, with the Sonnet lane gone) — a
// hardcoded key silently DROPS the new lane on every model generation. So:
// every top-level key whose value carries a `utilization` number IS a lane;
// known keys keep their historical labels, unknown keys derive one from the
// key itself ("seven_day_fable" -> "Weekly (Fable)"). Order: session first,
// the all-models weekly second, model lanes after — the popover's grammar.
//
// The key is also the lane's IDENTITY (`UsageWindow.id`). That split is the
// whole point: the label above is prose Anthropic rewrites, the key is not.
const KNOWN_LANES: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_fable: 'Weekly (Fable)',
  seven_day_oauth_apps: 'Weekly (OAuth apps)'
}

export function laneLabel(key: string): string {
  const known = KNOWN_LANES[key]
  if (known) return known
  if (key.startsWith('seven_day_')) return `Weekly (${titleCase(key.slice('seven_day_'.length))})`
  if (key.startsWith('five_hour_')) return `Session (${titleCase(key.slice('five_hour_'.length))})`
  // A shape we've never seen: show it under its own (humanized) name rather
  // than dropping data — "monthly_fable" reads as "Monthly fable".
  return titleCase(key.replace(/_/g, ' '))
}

/** The lane's window length is knowable from its key — carrying it means the
 *  pace engine never has to guess it back out of the display label. */
export const laneWindowMs = (key: string): number => (key.startsWith('five_hour') ? SESSION_MS : key.startsWith('seven_day') ? WEEK_MS : 0)

export const laneRank = (key: string): number => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : key.startsWith('five_hour') ? 2 : 3)

export function pctWindow(id: string, label: string, windowMs: number, w: unknown): UsageWindow | null {
  const o = w as { utilization?: unknown; resets_at?: unknown } | null
  if (!o || typeof o.utilization !== 'number') return null
  // Clamp, never round. Rounding here MANUFACTURED caps: 99.5 became 100, and
  // 100 is the pane-covering level. Display rounding is `displayPct`'s job, at
  // the moment a number is shown — not at the moment it is measured.
  const usedPct = Math.max(0, Math.min(100, o.utilization))
  const resetsAt = typeof o.resets_at === 'string' ? o.resets_at : undefined
  return { id, label, usedPct, resetsAt, windowMs }
}

/** The newer `limits[]` shape (dev-verified against CodexBar 2026-07-09,
 *  extended 2026-07-15): scoped weeklies ride `{kind: 'weekly_scoped', …,
 *  scope.model.display_name}`; the phase-11 rebuild also accepts plain
 *  `session` / `weekly_all` entries so the day Anthropic drops the flat keys,
 *  the two lanes that matter most do not silently vanish. (`is_active` is
 *  deliberately not filtered — enforceable scoped limits have been observed
 *  reporting false.)
 *
 *  Each entry is mapped back onto the FLAT key it is the same lane as, so the
 *  dedupe below can compare identities instead of prose: a scoped weekly whose
 *  `display_name` is "Claude Fable 4.5" and the flat `seven_day_fable` key are
 *  one lane served twice, and label-comparison could never see that. */
export function limitLanes(body: Record<string, unknown>): UsageWindow[] {
  const limits = body.limits
  if (!Array.isArray(limits)) return []
  const out: UsageWindow[] = []
  for (const raw of limits) {
    const l = raw as {
      kind?: unknown
      group?: unknown
      percent?: unknown
      resets_at?: unknown
      scope?: { model?: { display_name?: unknown; id?: unknown } }
    } | null
    if (!l || typeof l.percent !== 'number') continue
    let id: string | null = null
    let label: string | null = null
    let windowMs = 0
    if (l.kind === 'weekly_scoped' && l.group === 'weekly') {
      const name =
        typeof l.scope?.model?.display_name === 'string'
          ? l.scope.model.display_name
          : typeof l.scope?.model?.id === 'string'
            ? l.scope.model.id
            : 'model'
      id = `seven_day_${modelSlug(name)}`
      label = `Weekly (${name})`
      windowMs = WEEK_MS
    } else if (l.kind === 'session' || l.group === 'session') {
      id = 'five_hour'
      label = 'Session (5h)'
      windowMs = SESSION_MS
    } else if (l.kind === 'weekly_all' || (l.group === 'weekly' && !l.scope)) {
      id = 'seven_day'
      label = 'Weekly'
      windowMs = WEEK_MS
    }
    if (!id || !label) continue
    out.push({
      id,
      label,
      usedPct: Math.max(0, Math.min(100, l.percent)),
      windowMs,
      ...(typeof l.resets_at === 'string' ? { resetsAt: l.resets_at } : {})
    })
  }
  return out
}

/** A model's display name -> the flat key's model token. "Claude Fable 4.5"
 *  and "Opus 4.1" are the vendor's marketing strings for lanes the flat shape
 *  calls `seven_day_fable` / `seven_day_opus`: drop the vendor word and any
 *  version, keep the family. A name that reduces to nothing keeps its slug, so
 *  an unrecognized model is still a lane of its own rather than a collision. */
function modelSlug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && w !== 'claude' && !/^\d/.test(w))
  return (words[0] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '_')).replace(/^_+|_+$/g, '')
}

/** Lane ids must be UNIQUE within a plan — persisted single-fire state keys off
 *  them, so two windows sharing an id would share a latch and fight over it.
 *  First wins (flat keys are passed first, which is the dedupe the two served
 *  shapes need). A duplicate that is NOT a known collision — a body shape we
 *  have never seen, e.g. two scoped weeklies reducing to one family — keeps its
 *  data under a suffixed id rather than being dropped or merged: hiding a lane
 *  and corrupting a latch are both worse than an ugly key. */
export function uniqueLaneIds(windows: readonly UsageWindow[]): UsageWindow[] {
  const seen = new Set<string>()
  const out: UsageWindow[] = []
  for (const w of windows) {
    const base = w.id ?? ''
    if (!seen.has(base)) {
      seen.add(base)
      out.push(w)
      continue
    }
    let n = 2
    while (seen.has(`${base}_${n}`)) n++
    seen.add(`${base}_${n}`)
    out.push({ ...w, id: `${base}_${n}` })
  }
  return out
}

/** Every utilization-shaped key in the body, ordered session -> weekly ->
 *  model lanes, plus the `limits[]` lanes. Deduped by lane ID, not by label:
 *  a scoped weekly whose `display_name` is "Claude Fable 4.5" and the flat
 *  `seven_day_fable` key are ONE lane served under two spellings, and comparing
 *  prose could never see that — it rendered and alerted twice. */
export function parseLanes(body: Record<string, unknown>): UsageWindow[] {
  const flat = Object.keys(body)
    .filter((k) => {
      const v = body[k] as { utilization?: unknown } | null
      return !!v && typeof v === 'object' && typeof v.utilization === 'number'
    })
    .sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b))
    .map((k) => pctWindow(k, laneLabel(k), laneWindowMs(k), body[k]))
    .filter((w): w is UsageWindow => !!w)
  const seen = new Set(flat.map((w) => w.id))
  return uniqueLaneIds([...flat, ...limitLanes(body).filter((w) => !seen.has(w.id))])
}

/** `extra_usage` (the pay-as-you-go overage box): cents on the wire; a
 *  display value with its cap. The alert engine's spend branch reads this. */
export function parseExtraUsage(body: Record<string, unknown>): { amount: number; currency: string; limit?: number } | undefined {
  const x = body.extra_usage as { is_enabled?: unknown; used_credits?: unknown; monthly_limit?: unknown; currency?: unknown } | null
  if (!x || typeof x !== 'object' || x.is_enabled !== true || typeof x.used_credits !== 'number') return undefined
  return {
    amount: x.used_credits / 100,
    currency: typeof x.currency === 'string' && x.currency ? x.currency : 'USD',
    ...(typeof x.monthly_limit === 'number' && x.monthly_limit > 0 ? { limit: x.monthly_limit / 100 } : {})
  }
}

/** The plan the numbers belong to — `rate_limit_tier` when it carries the Max
 *  multiplier, else the credential's `subscriptionType`. Absent = plain
 *  "Claude", never a guess. */
export function planLabelFor(body: Record<string, unknown>, subscriptionType?: string): string {
  const tier = typeof body.rate_limit_tier === 'string' ? body.rate_limit_tier : ''
  const m = /^default_claude_max_(\d+)x$/.exec(tier)
  if (m) return `Claude (Max ${m[1]}x)`
  if (subscriptionType) return `Claude (${titleCase(subscriptionType)})`
  return 'Claude'
}
