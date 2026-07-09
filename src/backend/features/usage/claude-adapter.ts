import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanUsage, UsageAdapter, UsageWindow } from '@contracts'

// Claude usage adapter (Phase-7/01, ADR 0007). Reads the token Claude Code
// ITSELF stored — `.credentials.json` under the config home (win/linux) or
// the CLI's Keychain entry via security(1) on macOS — holds it in memory for
// the ONE request to the usage endpoint the CLI itself polls, and drops it.
// The token variable never leaves `fetchPlan`'s scope; errors carry human
// reasons only. Endpoint + shape dev-verified 2026-07-06 (books, phase-7/01);
// any drift lands as health 'error' with a reason — never a throw upward.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

function readKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout.trim())
    )
  })
}

/** The credential BLOB as the CLI stores it (both stores share the shape). */
async function readCredentialBlob(home: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychain()
    if (fromKeychain) return fromKeychain
    // Older installs / CLAUDE_CONFIG_DIR relocations fall back to the file.
  }
  const file = join(home, '.credentials.json')
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

function pctWindow(label: string, w: unknown): UsageWindow | null {
  const o = w as { utilization?: unknown; resets_at?: unknown } | null
  if (!o || typeof o.utilization !== 'number') return null
  const usedPct = Math.max(0, Math.min(100, Math.round(o.utilization)))
  const resetsAt = typeof o.resets_at === 'string' ? o.resets_at : undefined
  return { label, usedPct, resetsAt }
}

// ── Lane discovery is DYNAMIC, never a hardcoded model list. The endpoint's
// model-specific weekly lane has already changed name twice (seven_day_opus
// in the Opus era; seven_day_fable today, with the Sonnet lane gone) — a
// hardcoded key silently DROPS the new lane on every model generation. So:
// every top-level key whose value carries a `utilization` number IS a lane;
// known keys keep their historical labels, unknown keys derive one from the
// key itself ("seven_day_fable" -> "Weekly (Fable)"). Order: session first,
// the all-models weekly second, model lanes after — the popover's grammar.
const KNOWN_LANES: Record<string, string> = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_fable: 'Weekly (Fable)'
}

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function laneLabel(key: string): string {
  const known = KNOWN_LANES[key]
  if (known) return known
  if (key.startsWith('seven_day_')) return `Weekly (${titleCase(key.slice('seven_day_'.length))})`
  if (key.startsWith('five_hour_')) return `Session (${titleCase(key.slice('five_hour_'.length))})`
  // A shape we've never seen: show it under its own (humanized) name rather
  // than dropping data — "monthly_fable" reads as "Monthly fable".
  return titleCase(key.replace(/_/g, ' '))
}

const laneRank = (key: string): number => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : key.startsWith('five_hour') ? 2 : 3)

/** The newer `limits[]` shape (dev-verified against CodexBar 2026-07-09): the
 *  model-scoped weekly lane rides `{kind: 'weekly_scoped', group: 'weekly',
 *  percent, resets_at, scope.model.display_name}` entries — the Fable-era
 *  form; the flat `seven_day_<model>` keys were the previous generation. The
 *  display name comes from the payload VERBATIM, so the next model tier needs
 *  zero code here. (`is_active` is deliberately not filtered — enforceable
 *  scoped limits have been observed reporting false.) */
function scopedLanes(body: Record<string, unknown>): UsageWindow[] {
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
    if (!l || l.kind !== 'weekly_scoped' || l.group !== 'weekly' || typeof l.percent !== 'number') continue
    const name =
      typeof l.scope?.model?.display_name === 'string'
        ? l.scope.model.display_name
        : typeof l.scope?.model?.id === 'string'
          ? l.scope.model.id
          : 'model'
    out.push({
      label: `Weekly (${name})`,
      usedPct: Math.max(0, Math.min(100, Math.round(l.percent))),
      ...(typeof l.resets_at === 'string' ? { resetsAt: l.resets_at } : {})
    })
  }
  return out
}

/** Every utilization-shaped key in the body, ordered session -> weekly ->
 *  model lanes, plus the `limits[]` scoped weeklies (deduped by label). */
export function parseLanes(body: Record<string, unknown>): UsageWindow[] {
  const flat = Object.keys(body)
    .filter((k) => {
      const v = body[k] as { utilization?: unknown } | null
      return !!v && typeof v === 'object' && typeof v.utilization === 'number'
    })
    .sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b))
    .map((k) => pctWindow(laneLabel(k), body[k]))
    .filter((w): w is UsageWindow => !!w)
  const seen = new Set(flat.map((w) => w.label))
  return [...flat, ...scopedLanes(body).filter((w) => !seen.has(w.label))]
}

/** `extra_usage` (the pay-as-you-go overage box): cents on the wire; a
 *  display value with its cap, never a bill. */
export function parseExtraUsage(body: Record<string, unknown>): { amount: number; currency: string; limit?: number } | undefined {
  const x = body.extra_usage as { is_enabled?: unknown; used_credits?: unknown; monthly_limit?: unknown; currency?: unknown } | null
  if (!x || typeof x !== 'object' || x.is_enabled !== true || typeof x.used_credits !== 'number') return undefined
  return {
    amount: x.used_credits / 100,
    currency: typeof x.currency === 'string' && x.currency ? x.currency : 'USD',
    ...(typeof x.monthly_limit === 'number' && x.monthly_limit > 0 ? { limit: x.monthly_limit / 100 } : {})
  }
}

export const claudeAdapter: UsageAdapter = {
  id: 'claude',

  detect: async (home) => {
    if (process.platform === 'darwin') {
      if ((await readKeychain()) !== null) return { ok: true }
    }
    if (existsSync(join(home, '.credentials.json'))) return { ok: true }
    return { ok: false, reason: 'Claude Code is not signed in on this machine (no credentials found)' }
  },

  fetch: async (home, profileId, signal) => {
    const fetchPlan = async (): Promise<PlanUsage[]> => {
      const blob = await readCredentialBlob(home)
      if (!blob) throw new Error('Claude Code is not signed in (credentials missing)')
      let accessToken = ''
      try {
        const parsed = JSON.parse(blob) as { claudeAiOauth?: { accessToken?: string } }
        accessToken = parsed.claudeAiOauth?.accessToken ?? ''
      } catch {
        throw new Error('credential store unreadable — sign in again with the CLI')
      }
      if (!accessToken) throw new Error('no OAuth session — run `claude` and sign in')

      const res = await fetch(USAGE_URL, {
        signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json'
        }
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error('session expired — run `claude` and sign in again')
      }
      if (!res.ok) throw new Error(`usage endpoint answered ${res.status}`)

      const body = (await res.json()) as Record<string, unknown>
      const windows = parseLanes(body)
      if (!windows.length) throw new Error('usage endpoint shape changed — adapter needs a look')
      const spend = parseExtraUsage(body)

      return [
        {
          providerId: 'claude',
          profileId,
          planLabel: 'Claude',
          windows,
          ...(spend ? { spend } : {}),
          fetchedAt: Date.now(),
          health: 'fresh'
        }
      ]
    }
    return fetchPlan() // the token lives and dies inside fetchPlan's scope
  }
}
