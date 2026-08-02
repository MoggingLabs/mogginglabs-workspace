import { describe, expect, it } from 'vitest'
import { discardBody } from '@backend/features/integrations'

// THE ABANDONED RESPONSE BODY, pinned.
//
// Two paths in the REST bridge walk away from a response without reading it: the retry
// (the first attempt's body is never touched) and the pagination `break` on a non-ok page.
// An unread body holds its connection open until GC gets to it, so a per-tool retry on a
// hot loop is a socket leak — against SOMEONE ELSE'S API, where the first symptom is us
// exhausting their per-client connection limit and every tool call starting to fail.
//
// Tidying up must never become the caller's error, so the helper swallows everything: a
// body already consumed, already errored, or a fetch implementation without a cancellable
// stream are all exactly the state we wanted.

/** A Response-shaped double whose body records whether it was released. */
const bodyThat = (behaviour: 'ok' | 'throws' | 'rejects' | 'absent') => {
  let cancelled = false
  const body =
    behaviour === 'absent'
      ? null
      : {
          cancel: () => {
            cancelled = true
            if (behaviour === 'throws') throw new Error('already consumed')
            if (behaviour === 'rejects') return Promise.reject(new Error('stream errored'))
            return Promise.resolve()
          }
        }
  return { res: { body }, was: () => cancelled }
}

describe('discardBody', () => {
  it('releases a body we will never read', () => {
    const { res, was } = bodyThat('ok')
    discardBody(res)
    expect(was()).toBe(true)
  })

  it('does not throw when the body was already consumed', () => {
    const { res } = bodyThat('throws')
    expect(() => discardBody(res)).not.toThrow()
  })

  it('does not produce an unhandled rejection when cancelling fails', async () => {
    const { res } = bodyThat('rejects')
    expect(() => discardBody(res)).not.toThrow()
    // If the rejection were unhandled, this turn of the loop is where it would surface.
    await new Promise((r) => setTimeout(r, 0))
  })

  it('tolerates a response with no body at all', () => {
    const { res } = bodyThat('absent')
    expect(() => discardBody(res)).not.toThrow()
  })

  it('tolerates a fetch implementation whose body cannot be cancelled', () => {
    expect(() => discardBody({ body: {} })).not.toThrow()
    expect(() => discardBody({} as { body?: null })).not.toThrow()
  })
})
