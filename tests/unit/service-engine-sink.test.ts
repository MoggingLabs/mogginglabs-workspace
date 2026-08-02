import { describe, expect, it } from 'vitest'
import { ServiceEngine } from '@backend/features/integrations'
import type { LinkStatus, ServiceAdapter, ServiceLink } from '@contracts'

// THE MISATTRIBUTED THROW, pinned.
//
// onTransition is the notify/board-rules sink — other people's code, reached only after a
// SUCCESSFUL fetch. It was called inside the same try that guards the fetch, so a throw
// from it was caught by the fetch's catch: a perfectly good fresh status was rewritten to
// `stale`, and the backoff doubled.
//
// The link then reported itself unhealthy and polled ever more slowly, forever, because a
// downstream listener misbehaved once. The chip says "stale" while GitHub is answering
// fine, and nothing about the symptom points at the listener.

const link: ServiceLink = {
  id: 'l1',
  service: 'github',
  kind: 'pr',
  ref: 'o/r#1',
  cardId: 'c1',
  cadence: 'manual'
}

/** An adapter that always succeeds, returning the status it is given. */
const adapterReturning = (statuses: LinkStatus[]): ServiceAdapter => {
  let i = 0
  return {
    detect: async () => ({ ok: true }),
    fetch: async () => statuses[Math.min(i++, statuses.length - 1)]
  } as unknown as ServiceAdapter
}

const status = (over: Partial<LinkStatus>): LinkStatus => ({
  linkId: 'l1',
  health: 'fresh',
  fetchedAt: Date.now(),
  ...over
})

describe('ServiceEngine transition sink', () => {
  it('a throwing sink does not turn a healthy fetch stale', async () => {
    const engine = new ServiceEngine({
      adapters: { github: adapterReturning([status({ state: 'open' }), status({ state: 'merged' })]) },
      onPush: () => undefined,
      onTransition: () => {
        throw new Error('the board rules blew up')
      },
      jitter: () => 0
    })
    engine.addLink(link)
    await new Promise((r) => setTimeout(r, 0))
    engine.refresh('l1') // second fetch: open -> merged, so the sink fires and throws
    await new Promise((r) => setTimeout(r, 0))

    const s = engine.statusFor('l1')
    expect(s?.health).toBe('fresh') // was 'stale'
    expect(s?.state).toBe('merged') // and the fetched value survived
  })

  it('still announces the transition when the sink behaves', async () => {
    const seen: string[] = []
    const engine = new ServiceEngine({
      adapters: { github: adapterReturning([status({ state: 'open' }), status({ state: 'merged' })]) },
      onPush: () => undefined,
      onTransition: (_l, label) => seen.push(label),
      jitter: () => 0
    })
    engine.addLink(link)
    await new Promise((r) => setTimeout(r, 0))
    engine.refresh('l1')
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['PR #1: merged'])
  })

  it('a REAL fetch failure still degrades to stale', async () => {
    // The catch must keep doing its job — this is what the fix must not break.
    let n = 0
    const adapter = {
      detect: async () => ({ ok: true }),
      fetch: async () => {
        if (n++ === 0) return status({ state: 'open' })
        throw new Error('network down')
      }
    } as unknown as ServiceAdapter
    const engine = new ServiceEngine({
      adapters: { github: adapter },
      onPush: () => undefined,
      onTransition: () => undefined,
      jitter: () => 0
    })
    engine.addLink(link)
    await new Promise((r) => setTimeout(r, 0))
    engine.refresh('l1')
    await new Promise((r) => setTimeout(r, 0))
    expect(engine.statusFor('l1')?.health).toBe('stale')
  })
})
