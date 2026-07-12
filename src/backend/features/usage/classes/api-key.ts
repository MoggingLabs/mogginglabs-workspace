import type { PlanUsage, UsageWindow } from '@contracts'

// The `api-key` class (Phase-7/05, ADR 0007.a): ONE bounded usage/balance
// request per refresh, key resolved per the slot (OS-vault decrypt or env-ref)
// by an INJECTED resolver — this module never touches storage and the key
// lives only inside `fetch`'s scope. 401/403 -> error "key rejected — replace
// it in Settings"; missing key -> unconfigured naming the fix. Specs below are
// implemented from each provider's documented API; a spec is `parse`-defensive
// and any shape drift lands as health 'error' with a human reason. Providers
// without a dev-verified spec yet ship as catalog rows with an honest
// `unconfigured` reader (the 7/04 pattern) — never a guessed endpoint.

export interface ApiKeySpec {
  id: string
  /** Build the ONE request. Key goes in a header; never in the URL. */
  request(key: string): { url: string; headers: Record<string, string> }
  /** Normalize the 200 body. Throw Error(reason) on shape drift. */
  parse(body: unknown, now: number, profileId: string): PlanUsage
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function plan(id: string, profileId: string, label: string, now: number, windows: UsageWindow[], credits?: PlanUsage['credits']): PlanUsage {
  return { providerId: id, profileId, planLabel: label, windows, credits, fetchedAt: now, health: 'fresh' }
}

/** Specs for the documented providers. Each: one GET, bearer/header auth,
 *  defensive parse. (Endpoint URLs also live on the catalog rows as data.) */
export const API_KEY_SPECS: Record<string, ApiKeySpec> = {
  // OpenRouter: GET /api/v1/credits -> { data: { total_credits, total_usage } }
  openrouter: {
    id: 'openrouter',
    request: (key) => ({ url: 'https://openrouter.ai/api/v1/credits', headers: { Authorization: `Bearer ${key}` } }),
    parse: (body, now, profileId) => {
      const d = (body as { data?: { total_credits?: unknown; total_usage?: unknown } })?.data
      const total = num(d?.total_credits)
      const used = num(d?.total_usage)
      if (total === null || used === null) throw new Error('OpenRouter credits shape changed — adapter needs a look')
      const remaining = Math.max(0, total - used)
      const usedPct = total > 0 ? clamp((used / total) * 100) : 0
      return plan('openrouter', profileId, 'OpenRouter', now, [{ label: 'Credits', usedPct, windowMs: 0, raw: `$${remaining.toFixed(2)} left of $${total.toFixed(2)}` }], {
        label: 'USD',
        remaining: Math.round(remaining * 100) / 100
      })
    }
  },
  // DeepSeek: GET /user/balance -> { balance_infos: [{ currency, total_balance }] }
  deepseek: {
    id: 'deepseek',
    request: (key) => ({ url: 'https://api.deepseek.com/user/balance', headers: { Authorization: `Bearer ${key}` } }),
    parse: (body, now, profileId) => {
      const infos = (body as { balance_infos?: { currency?: string; total_balance?: unknown }[] })?.balance_infos
      const first = Array.isArray(infos) ? infos[0] : undefined
      // A DRAINED account is a legitimate balance, not a shape change: `0` is
      // falsy, so a truthiness guard here reported empty pockets as a broken
      // adapter. Only an ABSENT or unparsable field is drift.
      const raw = first?.total_balance
      const bal = raw === undefined || raw === null ? null : num(Number(raw))
      if (bal === null) throw new Error('DeepSeek balance shape changed — adapter needs a look')
      return plan('deepseek', profileId, 'DeepSeek', now, [{ label: 'Balance', usedPct: 0, windowMs: 0, raw: `${bal} ${first?.currency ?? ''}`.trim() }], {
        label: first?.currency ?? 'balance',
        remaining: bal
      })
    }
  },
  // Moonshot: GET /v1/users/me/balance -> { data: { available_balance } }
  moonshot: {
    id: 'moonshot',
    request: (key) => ({ url: 'https://api.moonshot.ai/v1/users/me/balance', headers: { Authorization: `Bearer ${key}` } }),
    parse: (body, now, profileId) => {
      const bal = num((body as { data?: { available_balance?: unknown } })?.data?.available_balance)
      if (bal === null) throw new Error('Moonshot balance shape changed — adapter needs a look')
      return plan('moonshot', profileId, 'Moonshot', now, [{ label: 'Balance', usedPct: 0, windowMs: 0, raw: `¥${bal}` }], { label: 'CNY', remaining: bal })
    }
  },
  // ElevenLabs: GET /v1/user/subscription -> { character_count, character_limit, next_character_count_reset_unix }
  elevenlabs: {
    id: 'elevenlabs',
    request: (key) => ({ url: 'https://api.elevenlabs.io/v1/user/subscription', headers: { 'xi-api-key': key } }),
    parse: (body, now, profileId) => {
      const b = body as { character_count?: unknown; character_limit?: unknown; next_character_count_reset_unix?: unknown; tier?: string }
      const used = num(b.character_count)
      const limit = num(b.character_limit)
      if (used === null || limit === null || limit <= 0) throw new Error('ElevenLabs subscription shape changed — adapter needs a look')
      const reset = num(b.next_character_count_reset_unix)
      return plan('elevenlabs', profileId, b.tier ? `ElevenLabs (${b.tier})` : 'ElevenLabs', now, [
        {
          label: 'Characters',
          usedPct: clamp((used / limit) * 100),
          resetsAt: reset ? new Date(reset * 1000).toISOString() : undefined,
          windowMs: 30 * 86_400_000,
          raw: `${used.toLocaleString()} / ${limit.toLocaleString()} chars`
        }
      ])
    }
  },
  // Deepgram: GET /v1/projects -> { projects: [...] } then balances would need a
  // second call — v1 reports project presence + leaves balance to a later pass.
  deepgram: {
    id: 'deepgram',
    request: (key) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${key}` } }),
    parse: (body, now, profileId) => {
      const projects = (body as { projects?: unknown[] })?.projects
      if (!Array.isArray(projects)) throw new Error('Deepgram projects shape changed — adapter needs a look')
      return plan('deepgram', profileId, 'Deepgram', now, [{ label: 'Balance', usedPct: 0, windowMs: 0, raw: `${projects.length} project(s) — balance detail in a later pass` }], {
        label: 'projects',
        remaining: projects.length
      })
    }
  }
}

/** The honest reader for api-key rows without a dev-verified spec yet. */
export const API_KEY_PENDING = new Set([
  'litellm',
  'minimax',
  'zai',
  'venice',
  'poe',
  'chutes',
  'groqcloud',
  'llmproxy',
  'clawrouter',
  'crof',
  'doubao',
  'warp',
  'alibaba',
  'openai-admin',
  'claude-admin'
])

export interface ApiKeyDeps {
  /** Injected by main (ADR 0007.a store). Null = no usable key. */
  resolveKey(providerId: string): Promise<string | null> | string | null
}

/** Fetch one api-key provider. The key exists only inside this scope. */
export async function fetchApiKeyUsage(id: string, profileId: string, signal: AbortSignal, deps: ApiKeyDeps): Promise<PlanUsage> {
  const now = Date.now()
  const labeled = (health: PlanUsage['health'], reason: string): PlanUsage => ({
    providerId: id,
    profileId,
    planLabel: '—',
    windows: [],
    fetchedAt: now,
    health,
    reason
  })
  if (API_KEY_PENDING.has(id)) return labeled('unconfigured', `${id} endpoint not dev-verified yet — the key you save stays ready`)
  const spec = API_KEY_SPECS[id]
  if (!spec) return labeled('unconfigured', 'no reader for this provider')
  const key = await deps.resolveKey(id)
  if (!key) return labeled('unconfigured', 'no key set — paste one in Settings § Usage (or set an env-ref)')
  const { url, headers } = spec.request(key)
  const res = await fetch(url, { signal, headers: { ...headers, 'Content-Type': 'application/json' } })
  if (res.status === 401 || res.status === 403) throw new Error('key rejected — replace it in Settings')
  if (res.status === 429) throw new Error('provider rate-limited the usage check — backing off')
  if (!res.ok) throw new Error(`usage endpoint answered ${res.status}`)
  return spec.parse(await res.json(), now, profileId)
}
