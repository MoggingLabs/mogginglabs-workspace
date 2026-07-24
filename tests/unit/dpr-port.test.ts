import { describe, expect, it } from 'vitest'

// The dpr-port re-arming contract. A `(resolution: Ndppx)` media query matches exactly
// one ratio, so the port must re-subscribe at the NEW ratio after every firing — miss
// that and the app hears the FIRST monitor hop but never a second (the grid would
// silently stop re-deriving on the way back). No live smoke can move a real monitor's
// scale factor, so the wiring is pinned here against a faithful matchMedia stub.

interface FakeMql {
  media: string
  handler?: () => void
  addEventListener: (type: string, cb: () => void, opts?: unknown) => void
}

describe('onDevicePixelRatioChange', () => {
  it('fires on change, re-arms at the new ratio, and honours unsubscribe', async () => {
    const queries: FakeMql[] = []
    ;(globalThis as { window?: unknown }).window = {
      devicePixelRatio: 1,
      matchMedia: (media: string): FakeMql => {
        const mql: FakeMql = {
          media,
          addEventListener: (_type, cb) => {
            mql.handler = cb
          }
        }
        queries.push(mql)
        return mql
      }
    }
    const { onDevicePixelRatioChange } = await import('@ui/core/system/dpr-port')

    let fired = 0
    const unsubscribe = onDevicePixelRatioChange(() => fired++)
    expect(queries).toHaveLength(1)
    expect(queries[0].media).toBe('(resolution: 1dppx)')

    // Monitor hop to 125% scaling: the armed query fires, subscribers hear it, and the
    // port re-arms against the NEW ratio (the old query is permanently false now).
    ;(window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1.25
    queries[0].handler!()
    expect(fired).toBe(1)
    expect(queries).toHaveLength(2)
    expect(queries[1].media).toBe('(resolution: 1.25dppx)')

    // ...and the hop BACK is heard too — the whole point of re-arming.
    ;(window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1
    queries[1].handler!()
    expect(fired).toBe(2)
    expect(queries).toHaveLength(3)

    // A second subscriber shares the one armed listener (no duplicate queries)...
    onDevicePixelRatioChange(() => undefined)
    expect(queries).toHaveLength(3)

    // ...and an unsubscribed callback stays silent while the port keeps listening.
    unsubscribe()
    queries[2].handler!()
    expect(fired).toBe(2)
    expect(queries).toHaveLength(4)
  })
})
