import { describe, expect, it } from 'vitest'
import { stampGen } from '@contracts'

// THE STALE-GEN BUG, pinned.
//
// Protocol v11 gen-gates input and resize: the daemon compares the generation on a
// command against the live session's and silently drops a mismatch (transport.ts:214,
// :221 — no else, no reply, no exit event). The renderer, though, writes its sessionGen
// exactly once, from its own spawn reply. Main's relay re-spawns every pane from ITS side
// on a reconnect replay, and a restarted daemon remints generations from 1 in restore
// order — so a pane can end up holding a number this daemon issued to a different pane,
// or never issued. The symptom is a pane that renders output and accepts nothing: no
// keystrokes, no resize, no banner, no way to tell it from a hung agent.
//
// The fix is an ownership rule, not a patch: identity minted by a lower layer is stamped
// by the layer that holds the authoritative map. Main's `gens` is refreshed by onGen from
// `spawned`/`attached` ahead of every replay, so main stamps and the renderer's copy is
// never trusted.

describe('stampGen', () => {
  it('stamps the generation MAIN holds, not whatever a client believes', () => {
    const gens = new Map<string, number | 'killed'>([['3', 7]])
    expect(stampGen(gens, '3')).toBe(7)
  })

  it('a fresh daemon that reminted gens is followed, not argued with', () => {
    // The exact heal: the renderer still holds 3, the restarted daemon reissued 1.
    const gens = new Map<string, number | 'killed'>([['3', 1]])
    expect(stampGen(gens, '3')).toBe(1)
    // Whatever the renderer thinks cannot enter the decision — there is no input for it.
    expect(stampGen(gens, '3')).not.toBe(3)
  })

  it('refuses outright for a pane the app has closed', () => {
    // The tombstone outranks everything: a disposed pane's stragglers must never reach
    // the session that reuses its id.
    const gens = new Map<string, number | 'killed'>([['3', 'killed']])
    expect(stampGen(gens, '3')).toBe('drop')
  })

  it('sends no gen for a pane it has not learned yet, rather than inventing one', () => {
    // The daemon accepts an unstamped command by design, so an unknown pane keeps the
    // pre-v11 behavior. Inventing a number here would drop input on a pane that works.
    expect(stampGen(new Map(), '3')).toBeUndefined()
  })

  // The resize handler banks dims into the stored spec so a reconnect REPLAY restores the
  // pane at its current size. It must only do that for a pane whose generation main knows:
  // an `undefined` gen is a pane we have never seen `spawned` for, which is also the shape
  // a late resize from a disposed pane arrives in. Banking its dims hands the replay a size
  // no live session ever had — and the replay decides how a restored pane comes back.
  it('says whether dims may be banked for the replay', () => {
    const mayBank = (gens: Map<string, number | 'killed'>, id: string): boolean =>
      typeof stampGen(gens, id) === 'number'

    expect(mayBank(new Map([['3', 7]]), '3')).toBe(true)
    expect(mayBank(new Map([['3', 'killed']]), '3')).toBe(false) // tombstoned
    expect(mayBank(new Map(), '3')).toBe(false) // never learned
  })

  it('never confuses one pane id for another', () => {
    const gens = new Map<string, number | 'killed'>([
      ['1', 4],
      ['2', 'killed']
    ])
    expect(stampGen(gens, '1')).toBe(4)
    expect(stampGen(gens, '2')).toBe('drop')
    expect(stampGen(gens, '10')).toBeUndefined()
  })
})
