import type { ModelPrice } from '@backend/features/usage'

// Live model pricing (the CodexBar models.dev idea): at most ONE bounded PUBLIC request
// per day (no auth, no cookies) to models.dev, persisted in the KV — so a scanned spend
// prices at today's published rates instead of the last release's built-ins. The scan
// itself stays network-free (rates arrive as DATA); this holder owns the fetch and cache.
// Real sessions only — a harness world never reaches out — and every failure path leaves
// the built-in table in charge, silently. Extracted from usage.ts's registerUsage so the
// live-network concern is one testable unit instead of a closure buried in a 470-line body.

const PRICES_TTL_MS = 24 * 3_600_000
const MODELS_DEV_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 8000
const KV_KEY = 'usage.prices.modelsdev'
const MAX_ROWS = 500

type PriceRow = [string, ModelPrice]

interface LivePrices {
  at: number
  rows: PriceRow[]
}

export interface PriceKv {
  get(key: string): string | null
  set(key: string, value: string): void
}

/**
 * The live-price cache: load-on-demand from the KV, refresh at most daily behind the TTL.
 * `enabled` is false under a harness world (no network, ever); `now`/`fetchJson` are
 * injectable so the refresh policy can be unit-tested without a clock or a socket.
 */
export class LivePriceCache {
  private cached: LivePrices | null = null
  private fetching = false

  constructor(
    private readonly kv: () => PriceKv | null,
    private readonly enabled: boolean,
    private readonly now: () => number = Date.now,
    private readonly fetchJson: (url: string) => Promise<unknown> = defaultFetchJson
  ) {}

  /** Today's rows for scanCost's `prices` option, or null when nothing is cached yet.
   *  Kicks off an async refresh when the cache is stale — THIS call uses whatever is
   *  cached, the NEXT one the fresh rates (the scan must never block on the network). */
  current(): { rows: PriceRow[]; rev: string } | null {
    this.refresh()
    return this.cached ? { rows: this.cached.rows, rev: String(this.cached.at) } : null
  }

  private load(): void {
    if (this.cached) return
    try {
      const raw = this.kv()?.get(KV_KEY)
      if (raw) {
        const p = JSON.parse(raw) as LivePrices | null
        if (p && Array.isArray(p.rows) && typeof p.at === 'number') this.cached = p
      }
    } catch {
      /* corrupt cache — refetch below */
    }
  }

  private refresh(): void {
    if (!this.enabled || this.fetching) return
    this.load()
    if (this.cached && this.now() - this.cached.at < PRICES_TTL_MS) return
    this.fetching = true
    void this.fetchJson(MODELS_DEV_URL)
      .then((body) => {
        const rows = parseModelsDev(body)
        if (!rows.length) return
        this.cached = { at: this.now(), rows: rows.slice(0, MAX_ROWS) }
        this.kv()?.set(KV_KEY, JSON.stringify(this.cached))
      })
      .catch(() => undefined) // offline / blocked — built-ins carry on
      .finally(() => {
        this.fetching = false
      })
  }
}

/** Pull anthropic + openai model rates out of the models.dev payload, longest id first so
 *  "gpt-5.4-mini" wins its prefix race with "gpt-5". Pure — the unit tier can bite on it. */
export function parseModelsDev(body: unknown): PriceRow[] {
  if (!body || typeof body !== 'object') return []
  const rows: PriceRow[] = []
  for (const providerKey of ['anthropic', 'openai']) {
    const models = (body as Record<string, { models?: Record<string, { cost?: { input?: unknown; output?: unknown } }> }>)[providerKey]?.models
    if (!models || typeof models !== 'object') continue
    for (const [id, m] of Object.entries(models)) {
      const inP = m?.cost?.input
      const outP = m?.cost?.output
      if (typeof inP === 'number' && typeof outP === 'number' && inP >= 0 && outP >= 0) {
        rows.push([id.toLowerCase(), { inPerMTok: inP, outPerMTok: outP }])
      }
    }
  }
  rows.sort((a, b) => b[0].length - a[0].length)
  return rows
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  return res.ok ? res.json() : null
}
