import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanUsage, UsageWindow } from '@contracts'
import { WINDOW_MS } from '@contracts'

// The `cli-store` class (Phase-7/04, ADR 0007): read the token/session a
// CLI/editor ALREADY stored, from its KNOWN location, in memory for the one
// read, then drop it. Every provider on this class is a READER here, keyed by
// id; the seam dispatches by `klass` and this map by id. A row with no reader
// yet degrades to `unconfigured` honestly — never a throw, never a guess.
//
// The token/credential NEVER leaves a reader's scope and never enters a
// PlanUsage (grep-proven in the smoke). Endpoints/shapes are dev-verified and
// dated in the catalog's `verifiedAt`; drift lands as health 'error'.

export type CliStoreReader = (home: string, profileId: string, signal: AbortSignal) => Promise<PlanUsage>

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

function labeled(providerId: string, profileId: string, health: PlanUsage['health'], reason: string): PlanUsage {
  return { providerId, profileId, planLabel: '—', windows: [], fetchedAt: Date.now(), health, reason }
}

// ── Codex: LOCAL session-log rate_limits (zero network) ──────────────────────
// Dev-verified 2026-07-06 (this machine, real login): the newest rollout under
// `~/.codex/sessions/**/*.jsonl` carries `rate_limits { primary, secondary }`,
// each `{ used_percent, window_minutes, resets_at }` (resets_at = epoch SECONDS;
// primary=300min session, secondary=10080min weekly). `plan_type` names the plan.
// Real values seen: primary 22% / secondary 42% / plan "prolite".
interface CodexRateLimit {
  used_percent?: number
  window_minutes?: number
  resets_at?: number
}
function findRateLimits(o: unknown): { primary?: CodexRateLimit; secondary?: CodexRateLimit; plan_type?: string } | null {
  if (!o || typeof o !== 'object') return null
  const rec = o as Record<string, unknown>
  if (rec.rate_limits && typeof rec.rate_limits === 'object') return rec.rate_limits as never
  for (const v of Object.values(rec)) {
    const found = findRateLimits(v)
    if (found) return found
  }
  return null
}

function codexWindow(label: string, kind: 'session' | 'weekly', rl?: CodexRateLimit): UsageWindow | null {
  if (!rl || typeof rl.used_percent !== 'number') return null
  const windowMs = typeof rl.window_minutes === 'number' ? rl.window_minutes * 60_000 : WINDOW_MS[kind]
  const resetsAt = typeof rl.resets_at === 'number' ? new Date(rl.resets_at * 1000).toISOString() : undefined
  return { label, usedPct: clampPct(rl.used_percent), resetsAt, windowMs }
}

/** Walk `<home>/sessions` newest-first; return the newest rollout file. Bounded
 *  to the CLI's OWN session tree — a known location, not a crawl. */
function newestCodexRollout(home: string): { file: string; mtime: number } | null {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  let best: { file: string; mtime: number } | null = null
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (name.endsWith('.jsonl')) {
        const m = st.mtimeMs
        if (!best || m > best.mtime) best = { file: p, mtime: m }
      }
    }
  }
  walk(root, 0)
  return best
}

export const readCodex: CliStoreReader = async (home, profileId) => {
  if (!existsSync(join(home, 'auth.json'))) {
    return labeled('codex', profileId, 'unconfigured', 'Codex is not signed in (run `codex` and log in)')
  }
  const roll = newestCodexRollout(home)
  if (!roll) return labeled('codex', profileId, 'unconfigured', 'no Codex session yet — run `codex` once to record usage')
  let rl: ReturnType<typeof findRateLimits> = null
  try {
    const lines = readFileSync(roll.file, 'utf8').trim().split('\n')
    for (let i = lines.length - 1; i >= 0 && !rl; i--) {
      try {
        rl = findRateLimits(JSON.parse(lines[i]))
      } catch {
        /* skip a malformed line */
      }
    }
  } catch {
    return labeled('codex', profileId, 'error', 'Codex session log unreadable')
  }
  if (!rl) return labeled('codex', profileId, 'unconfigured', 'Codex has not reported usage yet this session')
  const windows = [codexWindow('Session (5h)', 'session', rl.primary), codexWindow('Weekly', 'weekly', rl.secondary)].filter(
    (x): x is UsageWindow => x !== null
  )
  if (!windows.length) return labeled('codex', profileId, 'error', 'Codex usage shape changed — adapter needs a look')
  return {
    providerId: 'codex',
    profileId,
    planLabel: rl.plan_type ? `Codex (${rl.plan_type})` : 'Codex',
    windows,
    // The snapshot is as fresh as Codex last ran — stamp the rollout's mtime so
    // the UI shows honest age; it's real data, just possibly old.
    fetchedAt: roll.mtime,
    health: 'fresh'
  }
}

// ── Gemini: the CLI's own OAuth token + Google's private quota API (shape
// ported from steipete/CodexBar docs/gemini.md, 2026-07-15). We read
// `oauth_creds.json` the CLI already wrote and make the CLI's own two
// documented POSTs — loadCodeAssist (project + tier) then retrieveUserQuota
// (per-model buckets). We do NOT refresh the Google token ourselves (that
// would need the CLI's embedded client secret): an expired token degrades
// honestly to "run gemini once".
//
// June-2026 caveat (CodexBar's `consumerTierDeprecated`): Google retired this
// OAuth path for individual/AI Pro/Ultra accounts on 2026-06-18 — those
// answers carry UNSUPPORTED_CLIENT / IneligibleTierError, which must land as
// a labeled state naming the retirement, never a generic error.
const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const GEMINI_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

interface GeminiBucket {
  remainingFraction?: number
  resetTime?: string
  modelId?: string
}

export const readGemini: CliStoreReader = async (home, profileId, signal) => {
  const credsFile = join(home, 'oauth_creds.json')
  if (!existsSync(credsFile)) {
    return labeled('gemini', profileId, 'unconfigured', 'Gemini CLI is not signed in (run `gemini` and log in)')
  }
  let accessToken = ''
  let expiry = 0
  try {
    const creds = JSON.parse(readFileSync(credsFile, 'utf8')) as { access_token?: string; expiry_date?: number }
    accessToken = creds.access_token ?? ''
    expiry = typeof creds.expiry_date === 'number' ? creds.expiry_date : 0
  } catch {
    return labeled('gemini', profileId, 'error', 'Gemini credential store unreadable — sign in again with the CLI')
  }
  if (!accessToken) return labeled('gemini', profileId, 'unconfigured', 'no Gemini OAuth session — run `gemini` and sign in')
  // The CLI refreshes its own token on every run; we never mint one (the
  // client secret is the CLI's, not ours — the claude-refresh rationale).
  if (expiry && expiry <= Date.now()) {
    return labeled('gemini', profileId, 'error', 'Gemini token expired — run `gemini` once to refresh it')
  }
  const post = async (url: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> => {
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* some errors are plain text */
    }
    return { status: res.status, json, text }
  }
  const retired = (text: string): boolean => /UNSUPPORTED_CLIENT|IneligibleTierError/i.test(text)
  const assist = await post(GEMINI_ASSIST_URL, { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } })
  if (retired(assist.text))
    return labeled('gemini', profileId, 'unconfigured', 'Google retired Gemini CLI OAuth for individual accounts (June 2026) — quota is no longer served for this account tier')
  if (assist.status === 401 || assist.status === 403)
    return labeled('gemini', profileId, 'error', 'Gemini session rejected — run `gemini` once to refresh it')
  const assistBody = assist.json as { cloudaicompanionProject?: string; currentTier?: { name?: string; id?: string }; paidTier?: { name?: string } } | null
  const project = typeof assistBody?.cloudaicompanionProject === 'string' ? assistBody.cloudaicompanionProject : undefined
  const tier = assistBody?.paidTier?.name ?? assistBody?.currentTier?.name
  const quota = await post(GEMINI_QUOTA_URL, project ? { project } : {})
  if (retired(quota.text))
    return labeled('gemini', profileId, 'unconfigured', 'Google retired Gemini CLI OAuth for individual accounts (June 2026) — quota is no longer served for this account tier')
  if (quota.status === 401 || quota.status === 403)
    return labeled('gemini', profileId, 'error', 'Gemini session rejected — run `gemini` once to refresh it')
  if (quota.status !== 200) return labeled('gemini', profileId, 'error', `Gemini quota endpoint answered ${quota.status}`)
  const buckets = ((quota.json as { buckets?: GeminiBucket[] } | null)?.buckets ?? []).filter(
    (b) => typeof b.remainingFraction === 'number' && typeof b.modelId === 'string'
  )
  if (!buckets.length) return labeled('gemini', profileId, 'error', 'Gemini quota shape changed — adapter needs a look')
  // Per CodexBar's mapping: for each family, the LOWEST remaining fraction
  // wins (the binding limit); Pro is the primary lane, Flash the secondary.
  const lane = (match: (id: string) => boolean, label: string): UsageWindow | null => {
    const mine = buckets.filter((b) => match((b.modelId ?? '').toLowerCase()))
    if (!mine.length) return null
    const worst = mine.reduce((a, b) => ((a.remainingFraction ?? 1) <= (b.remainingFraction ?? 1) ? a : b))
    return {
      label,
      usedPct: clampPct((1 - (worst.remainingFraction ?? 1)) * 100),
      windowMs: WINDOW_MS.daily,
      ...(worst.resetTime ? { resetsAt: worst.resetTime } : {})
    }
  }
  const windows = [lane((id) => id.includes('pro'), 'Daily (Pro)'), lane((id) => id.includes('flash'), 'Daily (Flash)')].filter(
    (w): w is UsageWindow => w !== null
  )
  if (!windows.length) return labeled('gemini', profileId, 'error', 'Gemini quota buckets named no known model family')
  return {
    providerId: 'gemini',
    profileId,
    planLabel: tier ? `Gemini (${tier})` : 'Gemini',
    windows,
    fetchedAt: Date.now(),
    health: 'fresh'
  }
}

// ── Copilot: CLI-stored token + usage API (NOT the app-held device flow). ─────
// Reader shape pending real-login dev-verification; ships honestly unconfigured.
const notWired =
  (id: string): CliStoreReader =>
  async (_home, profileId) =>
    labeled(id, profileId, 'unconfigured', `${id} usage reader is not wired yet — coming in a later 7/04 pass`)

/** The cli-store rows whose reader actually READS something (vs the honest
 *  notWired stubs below). The UI's truthfulness rides on this set: a row
 *  outside it must never present as watched. */
export const CLI_STORE_WIRED: ReadonlySet<string> = new Set(['codex', 'gemini'])

/** Reader registry. Claude is delegated by the seam to the shipped 7/01 adapter
 *  (already verified) so this map holds the NEW cli-store readers. */
export const CLI_STORE_READERS: Record<string, CliStoreReader> = {
  codex: readCodex,
  gemini: readGemini,
  copilot: notWired('copilot'),
  zed: notWired('zed'),
  kiro: notWired('kiro'),
  kilo: notWired('kilo'),
  augment: notWired('augment'),
  jetbrains: notWired('jetbrains'),
  codebuff: notWired('codebuff'),
  opencode: notWired('opencode'),
  windsurf: notWired('windsurf')
}

/** Optional: a CLI presence probe (execFile with timeout) for detect(). Unused
 *  by the local-file readers but here for readers that shell out to a CLI. */
export function cliOnPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFile(probe, [bin], { timeout: 4000 }, (err) => resolve(!err))
  })
}
