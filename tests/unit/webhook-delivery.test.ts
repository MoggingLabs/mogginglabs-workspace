import { describe, expect, it } from 'vitest'
import { classifyWebhookUrl, deliverWebhook, urlAllowed } from '@backend/features/integrations/bridge'
import type { BridgeEvent } from '@contracts'

// OUTBOUND WEBHOOKS: WHERE THEY MAY GO, AND HOW HARD WE TRY.
//
// Two separate hazards. A webhook URL is user-supplied and the app fetches it, so an
// unclassified one is a request forgery primitive — the app reaches an address the user's
// browser could not. And a retry loop that does not distinguish "the server is broken" from
// "the server refused you" retries a 404 forever.
//
// `deliverWebhook` takes its fetch and its sleep as parameters, so this needs no clock and no
// network — the module was built for exactly this and simply never had a test.

const EVENT = { kind: 'needs-you', workspaceId: 'ws', at: 0 } as unknown as BridgeEvent

const recorder = (status: number | number[]) => {
  const codes = Array.isArray(status) ? status : [status]
  const calls: string[] = []
  const sleeps: number[] = []
  let n = 0
  return {
    calls,
    sleeps,
    fetchFn: async (url: string) => {
      calls.push(url)
      return { status: codes[Math.min(n++, codes.length - 1)]! }
    },
    sleep: async (ms: number) => {
      sleeps.push(ms)
    }
  }
}

describe('deliverWebhook', () => {
  it('a 2xx is one attempt and no waiting', async () => {
    const r = recorder(200)
    const out = await deliverWebhook('https://hook.test/x', EVENT, r)
    expect(out.ok).toBe(true)
    expect(r.calls).toHaveLength(1)
    expect(r.sleeps).toEqual([])
  })

  // THE distinction. A 4xx means "the server understood and refused" — retrying cannot change
  // that, and doing so hammers someone else's endpoint on every event forever.
  it('does not retry a 4xx', async () => {
    const r = recorder(404)
    const out = await deliverWebhook('https://hook.test/x', EVENT, r)
    expect(out.ok).toBe(false)
    expect(r.calls, 'a refusal is final').toHaveLength(1)
  })

  it('retries a 5xx with a growing backoff', async () => {
    const r = recorder(500)
    const out = await deliverWebhook('https://hook.test/x', EVENT, r)
    expect(out.ok).toBe(false)
    expect(r.calls.length).toBeGreaterThan(1)
    // Asserted on the injected sleep's ARGUMENTS, never on wall time — a test that waits is a
    // test that flakes.
    expect(r.sleeps.length).toBe(r.calls.length - 1)
    for (let i = 1; i < r.sleeps.length; i++) expect(r.sleeps[i]!).toBeGreaterThan(r.sleeps[i - 1]!)
  })

  it('stops as soon as a retry succeeds', async () => {
    const r = recorder([500, 200])
    const out = await deliverWebhook('https://hook.test/x', EVENT, r)
    expect(out.ok).toBe(true)
    expect(r.calls).toHaveLength(2)
  })

  it('honours maxAttempts', async () => {
    const r = recorder(500)
    await deliverWebhook('https://hook.test/x', EVENT, { ...r, maxAttempts: 2 })
    expect(r.calls).toHaveLength(2)
  })
})

describe('classifyWebhookUrl', () => {
  it('https anywhere is the ordinary case', () => {
    expect(classifyWebhookUrl('https://hooks.example.com/x')).toBe('https')
  })

  it('names loopback and LAN rather than lumping them with the public internet', () => {
    expect(classifyWebhookUrl('http://127.0.0.1:9000/x')).toBe('http-loopback')
    expect(classifyWebhookUrl('http://localhost/x')).toBe('http-loopback')
    expect(classifyWebhookUrl('http://192.168.1.5/x')).toBe('http-lan')
    expect(classifyWebhookUrl('http://10.0.0.5/x')).toBe('http-lan')
  })

  // The 172.16/12 block is 172.16–172.31. Off-by-one at either end classifies a PUBLIC address
  // as LAN, which is the direction that matters.
  it('gets the 172.16/12 boundaries right at both ends', () => {
    expect(classifyWebhookUrl('http://172.15.0.1/x'), '172.15 is public').toBe('invalid')
    expect(classifyWebhookUrl('http://172.16.0.1/x')).toBe('http-lan')
    expect(classifyWebhookUrl('http://172.31.255.254/x')).toBe('http-lan')
    expect(classifyWebhookUrl('http://172.32.0.1/x'), '172.32 is public').toBe('invalid')
  })

  it('refuses plain http to a public host, and anything that is not a URL', () => {
    expect(classifyWebhookUrl('http://example.com/x')).toBe('invalid')
    expect(classifyWebhookUrl('not a url')).toBe('invalid')
    expect(classifyWebhookUrl('file:///etc/passwd')).toBe('invalid')
  })
})

describe('urlAllowed', () => {
  it('lets https through with no acknowledgement', () => {
    expect(urlAllowed('https://hooks.example.com/x', false).ok).toBe(true)
  })

  it('requires an explicit acknowledgement for unencrypted LAN', () => {
    const refused = urlAllowed('http://192.168.1.5/x', false)
    expect(refused.ok).toBe(false)
    expect(refused.reason, 'the refusal has to say what to do about it').toBeTruthy()
    expect(urlAllowed('http://192.168.1.5/x', true).ok).toBe(true)
  })

  it('never lets an invalid URL through, acknowledged or not', () => {
    expect(urlAllowed('http://example.com/x', true).ok).toBe(false)
  })
})
