import { describe, expect, it } from 'vitest'
import {
  PANE_SLOT_STRIDE,
  displayPaneNumber,
  formulaOrdinalOf,
  formulaPaneId,
  locatePane
} from '@contracts'

// locatePane is now the ONE pane→workspace resolver — main's grants/browser routing and
// the renderer's ports both call it. The moved-pane cases below are the ones main's old
// bare-formula copy got wrong: a pane moved between workspaces kept resolving to the
// workspace it LEFT, so per-workspace grants followed the wrong workspace.

const WS = (ordinal: number, id: string, paneIds?: (number | null)[]): { id: string; ordinal: number; paneIds?: (number | null)[] } =>
  paneIds ? { id, ordinal, paneIds } : { id, ordinal }

describe('pane id formula', () => {
  it('formulaPaneId and formulaOrdinalOf invert each other over the stride', () => {
    expect(formulaPaneId(0, 1)).toBe(1)
    expect(formulaPaneId(2, 3)).toBe(2 * PANE_SLOT_STRIDE + 3)
    expect(formulaOrdinalOf(203)).toBe(2)
  })

  it('displayPaneNumber wears the slot, falling back to the raw id', () => {
    expect(displayPaneNumber(203)).toBe(3)
    expect(displayPaneNumber(7)).toBe(7)
    expect(displayPaneNumber(200)).toBe(200) // slot 0 is not a slot — show the id honestly
  })
})

describe('locatePane', () => {
  it('resolves a formula pane to its birth workspace and slot', () => {
    const a = WS(0, 'a')
    const b = WS(2, 'b')
    expect(locatePane([a, b], 203)).toEqual({ ws: b, slot: 3 })
    expect(locatePane([a, b], 1)).toEqual({ ws: a, slot: 1 })
  })

  it('an explicit paneIds claim outranks the formula (the moved pane)', () => {
    const birth = WS(1, 'birth')
    const adoptive = WS(2, 'adoptive', [null, 103])
    // Pane 103 was born in ordinal 1 but moved to 'adoptive' slot 2.
    expect(locatePane([birth, adoptive], 103)).toEqual({ ws: adoptive, slot: 2 })
  })

  it('a re-let formula slot no longer answers for the pane that moved out', () => {
    // Workspace ordinal 1's slot 3 now hosts pane 205 (moved in) — so pane 103's
    // formula answer is dead, and with nobody claiming 103 it resolves to nothing.
    const ws = WS(1, 'w', [null, null, 205])
    expect(locatePane([ws], 103)).toBeUndefined()
    expect(locatePane([ws], 205)).toEqual({ ws, slot: 3 })
  })

  it('fails closed on ids outside the formula and unknown ordinals', () => {
    expect(locatePane([WS(0, 'a')], 0)).toBeUndefined() // slots start at 1
    expect(locatePane([WS(0, 'a')], 501)).toBeUndefined() // no ordinal-5 workspace
  })
})
