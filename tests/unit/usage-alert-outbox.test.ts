import { describe, expect, it } from 'vitest'
import {
  ackOutbox,
  drainOutbox,
  enqueueAlerts,
  outboxLive,
  CAPPED_BOUNDLESS_TTL_MS,
  MAX_DRAINS,
  OUTBOX_CAP,
  type QueuedAlert
} from '@backend/features/usage/alert-outbox'

// Delivery hygiene. The queue exists so a decision and its delivery do not share
// a fate — right for NEWS. What broke is that news about a 5-hour window was kept
// for 24 hours and then replayed into an input-blocking overlay.

const NOW = Date.parse('2026-08-02T12:00:00Z')
const HOUR = 3_600_000

const q = (over: Partial<QueuedAlert> = {}): QueuedAlert => ({
  kind: 'threshold',
  level: 'capped',
  providerId: 'claude',
  profileId: 'cdev',
  planLabel: 'Claude (Max 20x)',
  windowLabel: 'Session (5h)',
  usedPct: 100,
  title: 'Claude (Max 20x) — usage limit reached (Session (5h))',
  body: '100% of Session (5h) used',
  alertId: 'a1',
  queuedAt: NOW - 20 * 60_000,
  resetsAt: new Date(NOW + HOUR).toISOString(),
  ...over
})

describe('outboxLive', () => {
  // ── THE INCIDENT. A capped alert about a window that has since rolled is not
  // stale news, it is FALSE news — and it used to survive nineteen more hours.
  it('THE INCIDENT: a capped alert whose window has already rolled is neither delivered nor kept', () => {
    const rolled = q({ resetsAt: new Date(NOW - 5 * 60_000).toISOString() })
    expect(outboxLive(rolled, NOW)).toBe(false)
    expect(drainOutbox([rolled], NOW)).toEqual({ deliver: [], keep: [] })
  })

  it('...while the same alert with a live window is delivered and kept, counted', () => {
    const live = q()
    const { deliver, keep } = drainOutbox([live], NOW)
    expect(deliver).toHaveLength(1)
    expect(deliver[0].drains).toBe(1)
    expect(keep).toHaveLength(1)
  })

  it('the rule applies to every kind — a reset alert about a rolled window is spent too', () => {
    const reset = q({ kind: 'reset', level: undefined, resetsAt: new Date(NOW - 1).toISOString() })
    expect(outboxLive(reset, NOW)).toBe(false)
  })

  it('a BOUNDLESS capped claim expires in an hour — unverifiable news gets a short leash', () => {
    const noBoundary = q({ resetsAt: undefined, queuedAt: NOW - CAPPED_BOUNDLESS_TTL_MS - 1 })
    expect(outboxLive(noBoundary, NOW)).toBe(false)
    expect(outboxLive(q({ resetsAt: undefined, queuedAt: NOW - 59 * 60_000 }), NOW)).toBe(true)
  })

  it('a non-capped alert with no boundary keeps the 24h outer bound', () => {
    const warn = q({ level: 'warn', resetsAt: undefined, queuedAt: NOW - 23 * HOUR })
    expect(outboxLive(warn, NOW)).toBe(true)
    expect(outboxLive({ ...warn, queuedAt: NOW - 25 * HOUR }, NOW)).toBe(false)
  })

  it('an unparseable boundary does not silently kill the entry — the TTL still governs', () => {
    expect(outboxLive(q({ resetsAt: 'not-a-date' }), NOW)).toBe(true)
    expect(outboxLive(q({ resetsAt: 'not-a-date', queuedAt: NOW - 25 * HOUR }), NOW)).toBe(false)
  })
})

describe('the dead-letter bound', () => {
  it('an entry offered MAX_DRAINS times is delivered that last time, then never again', () => {
    // `alertAck` is fire-and-forget: a rejected ack leaves the entry queued, and
    // with nothing bounding the retries that is at-least-once FOREVER.
    let queue: QueuedAlert[] = [q()]
    const counts: number[] = []
    for (let i = 0; i < MAX_DRAINS + 2; i++) {
      const { deliver, keep } = drainOutbox(queue, NOW)
      counts.push(deliver.length)
      queue = keep
    }
    expect(counts).toEqual([1, 1, 1, 0, 0])
    expect(queue).toEqual([])
  })
})

describe('enqueue and ack', () => {
  it('compacts dead entries on the way in and holds the cap, newest-wins', () => {
    const dead = q({ alertId: 'dead', resetsAt: new Date(NOW - 1).toISOString() })
    const fresh = Array.from({ length: OUTBOX_CAP + 5 }, (_, i) => q({ alertId: `n${i}` }))
    const out = enqueueAlerts([dead], fresh, NOW)
    expect(out).toHaveLength(OUTBOX_CAP)
    expect(out.some((a) => a.alertId === 'dead')).toBe(false)
    expect(out[out.length - 1].alertId).toBe(`n${OUTBOX_CAP + 4}`)
  })

  it('ack removes exactly the acked id and nothing else', () => {
    const queue = [q({ alertId: 'a' }), q({ alertId: 'b' }), q({ alertId: 'c' })]
    expect(ackOutbox(queue, 'b').map((a) => a.alertId)).toEqual(['a', 'c'])
    expect(ackOutbox(queue, 'nope').map((a) => a.alertId)).toEqual(['a', 'b', 'c'])
  })
})
