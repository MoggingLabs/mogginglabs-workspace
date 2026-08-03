import { describe, expect, it } from 'vitest'
import { PaneStateHistory } from '@backend/features/integrations'

// THE REUSED PANE ID, pinned — the bridge edition.
//
// The bridge fires `needs-you` on a TRANSITION into attention, so it remembers each pane's
// previous state, keyed by pane id. Pane ids are REUSED: a split takes the lowest free
// slot. Nothing forgot a closed pane, so its last state became the "previous" state of
// whatever opened at that id next — and a successor whose very FIRST state is attention
// found prev === 'attention', the transition was swallowed, and the user's automations
// never heard about the one pane that opened already needing them.
//
// The event that gets eaten is exactly the event worth having.

describe('PaneStateHistory', () => {
  it('fires on the transition INTO the watched state, once', () => {
    const h = new PaneStateHistory()
    expect(h.enters(1, 'idle', 'attention')).toBe(false)
    expect(h.enters(1, 'attention', 'attention')).toBe(true)
    expect(h.enters(1, 'attention', 'attention')).toBe(false) // still there, not a transition
    expect(h.enters(1, 'idle', 'attention')).toBe(false)
    expect(h.enters(1, 'attention', 'attention')).toBe(true) // re-entered
  })

  it('fires when a pane is born already in the watched state', () => {
    const h = new PaneStateHistory()
    expect(h.enters(7, 'attention', 'attention')).toBe(true)
  })

  // THE regression.
  it('a REUSED pane id does not inherit its predecessor’s state', () => {
    const h = new PaneStateHistory()
    h.enters(3, 'attention', 'attention') // pane 3 rings...
    h.forget(3) // ...and is closed
    // A new pane takes slot 3 and its first state is attention. Without forget(), prev is
    // still 'attention' and this returns false — the event is lost.
    expect(h.enters(3, 'attention', 'attention')).toBe(true)
  })

  it('forgetting is per pane and does not disturb its neighbours', () => {
    const h = new PaneStateHistory()
    h.enters(1, 'attention', 'attention')
    h.enters(2, 'attention', 'attention')
    h.forget(1)
    expect(h.enters(2, 'attention', 'attention')).toBe(false) // pane 2 never left
    expect(h.enters(1, 'attention', 'attention')).toBe(true) // pane 1 is new again
  })

  it('does not grow without bound as panes come and go', () => {
    const h = new PaneStateHistory()
    for (let i = 0; i < 100; i++) {
      h.enters(i, 'attention', 'attention')
      h.forget(i)
    }
    expect(h.size()).toBe(0)
  })

  it('forgetting an unknown pane is harmless', () => {
    const h = new PaneStateHistory()
    expect(() => h.forget(99)).not.toThrow()
  })
})
