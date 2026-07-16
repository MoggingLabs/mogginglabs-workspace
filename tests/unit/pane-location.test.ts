import { describe, expect, it } from 'vitest'
import { locatePaneWorkspace, type PaneHost } from '@contracts'

// The moved-pane resolution rule (finding B1): an explicit `paneIds` claim outranks
// the `ordinal * 100 + slot` birth formula. Main resolves consent/grants with this,
// the renderer resolves tabs/notifications with it — one function, or an agent in a
// moved pane drives a browser its human granted for a different workspace.

const ws = (id: string, ordinal: number, paneIds?: (number | null)[]): PaneHost => ({ id, ordinal, paneIds })

describe('locatePaneWorkspace', () => {
  it('resolves a born pane by the formula', () => {
    const hosts = [ws('a', 0), ws('b', 1)]
    expect(locatePaneWorkspace(hosts, 101)).toEqual({ workspace: hosts[1], slot: 1 })
    expect(locatePaneWorkspace(hosts, 3)).toEqual({ workspace: hosts[0], slot: 3 })
  })

  it('lets an explicit paneIds claim outrank the formula (a moved pane)', () => {
    // Pane 101 was born in ordinal-1 ("b") and MOVED to "a", which claims it in slot 3.
    const hosts = [ws('a', 0, [null, null, 101]), ws('b', 1)]
    expect(locatePaneWorkspace(hosts, 101)).toEqual({ workspace: hosts[0], slot: 3 })
  })

  it('refuses the formula for a slot re-let to a pane from elsewhere', () => {
    // Slot 1 of "b" now hosts pane 205 (moved in); pane 101 moved out and nobody
    // claims it — it is gone, not still b's.
    const hosts = [ws('a', 0), ws('b', 1, [205])]
    expect(locatePaneWorkspace(hosts, 101)).toBeUndefined()
    expect(locatePaneWorkspace(hosts, 205)).toEqual({ workspace: hosts[1], slot: 1 })
  })

  it('lets a null paneIds hole fall through to the formula', () => {
    const hosts = [ws('b', 1, [null, 205])]
    expect(locatePaneWorkspace(hosts, 101)).toEqual({ workspace: hosts[0], slot: 1 })
    expect(locatePaneWorkspace(hosts, 205)).toEqual({ workspace: hosts[0], slot: 2 })
  })

  it('fails closed on slot zero, unknown ordinals, and junk ids', () => {
    const hosts = [ws('a', 0), ws('b', 1)]
    expect(locatePaneWorkspace(hosts, 100)).toBeUndefined() // slot 0 — never a pane
    expect(locatePaneWorkspace(hosts, 501)).toBeUndefined() // no ordinal-5 workspace
    expect(locatePaneWorkspace(hosts, 0)).toBeUndefined()
    expect(locatePaneWorkspace(hosts, -3)).toBeUndefined()
    expect(locatePaneWorkspace(hosts, 1.5)).toBeUndefined()
    expect(locatePaneWorkspace(hosts, Number('pane'))).toBeUndefined()
    expect(locatePaneWorkspace([], 101)).toBeUndefined()
  })

  it('keeps a claim authoritative even when the formula also matches it', () => {
    // A pane claimed by its OWN birth workspace (restore writes these) resolves
    // identically — the claim and the formula agree.
    const hosts = [ws('b', 1, [101])]
    expect(locatePaneWorkspace(hosts, 101)).toEqual({ workspace: hosts[0], slot: 1 })
  })
})
