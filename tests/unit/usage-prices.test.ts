import { describe, expect, it } from 'vitest'
import { LivePriceCache, parseModelsDev, type PriceKv } from '../../src/main/usage-prices'

// The live-price fetch/cache/TTL policy, lifted out of usage.ts's registerUsage closure so
// it can be tested without a clock or a socket — the fetchJson and now() are injected.

const BODY = {
  anthropic: {
    models: {
      'claude-fable-5': { cost: { input: 10, output: 50 } },
      'no-cost': {},
      'bad-cost': { cost: { input: 'x', output: 3 } }
    }
  },
  openai: { models: { 'gpt-5': { cost: { input: 1.25, output: 10 } }, 'gpt-5-mini': { cost: { input: 0.25, output: 2 } } } },
  google: { models: { 'gemini-x': { cost: { input: 1, output: 2 } } } } // not anthropic/openai — ignored
}

const memKv = (): PriceKv & { store: Map<string, string> } => {
  const store = new Map<string, string>()
  return { store, get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) }
}

describe('parseModelsDev', () => {
  it('keeps anthropic+openai rows with numeric non-negative costs, longest id first', () => {
    const rows = parseModelsDev(BODY)
    expect(rows.map((r) => r[0])).toEqual(['claude-fable-5', 'gpt-5-mini', 'gpt-5'])
    expect(rows.find((r) => r[0] === 'gpt-5')?.[1]).toEqual({ inPerMTok: 1.25, outPerMTok: 10 })
  })

  it('returns [] for junk', () => {
    expect(parseModelsDev(null)).toEqual([])
    expect(parseModelsDev('nope')).toEqual([])
    expect(parseModelsDev({})).toEqual([])
  })
})

describe('LivePriceCache', () => {
  it('is inert when disabled (harness world): no fetch, no rows', async () => {
    let fetched = 0
    const cache = new LivePriceCache(() => memKv(), false, () => 0, async () => (fetched++, BODY))
    expect(cache.current()).toBeNull()
    await Promise.resolve()
    expect(fetched).toBe(0)
  })

  it('fetches once when enabled, then serves the cached rows and persists them', async () => {
    const kv = memKv()
    let fetched = 0
    const cache = new LivePriceCache(() => kv, true, () => 1000, async () => (fetched++, BODY))
    expect(cache.current()).toBeNull() // first call kicks the async fetch; nothing cached yet
    await Promise.resolve()
    await Promise.resolve()
    const now = cache.current()
    expect(now?.rows.map((r) => r[0])).toEqual(['claude-fable-5', 'gpt-5-mini', 'gpt-5'])
    expect(now?.rev).toBe('1000')
    expect(kv.store.get('usage.prices.modelsdev')).toContain('claude-fable-5')
    expect(fetched).toBe(1) // still cached within the TTL — no second fetch
  })

  it('loads a persisted cache without refetching inside the TTL', async () => {
    const kv = memKv()
    kv.store.set('usage.prices.modelsdev', JSON.stringify({ at: 5000, rows: [['gpt-5', { inPerMTok: 1, outPerMTok: 2 }]] }))
    let fetched = 0
    const cache = new LivePriceCache(() => kv, true, () => 5000 + 1000, async () => (fetched++, BODY))
    const now = cache.current()
    expect(now?.rows[0][0]).toBe('gpt-5')
    await Promise.resolve()
    expect(fetched).toBe(0)
  })
})
