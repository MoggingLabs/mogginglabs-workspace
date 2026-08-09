import { describe, expect, it } from 'vitest'
import {
  assignedTotal,
  countOf,
  expandAssignments,
  fillAll,
  fillEmpty,
  normalizeSlots,
  paintSlot,
  pruneBrush,
  pruneToRoster,
  restoreLineup,
  setSlotCount,
  type SlotId
} from '@ui/features/agents/placement-model'

// The wizard and the New-terminals modal paint the same lineup onto different canvases.
// This arithmetic used to exist twice, verbatim, in files that touch the DOM — so nothing
// asserted it. These are the rules a user would notice being wrong.

describe('the launch manifest is slot-ordered', () => {
  it('terminal k runs what was painted on terminal k', () => {
    expect(expandAssignments(['claude', null, 'codex'], 3, '')).toEqual(['claude', 'shell', 'codex'])
  })

  it('a custom placement carries the command', () => {
    expect(expandAssignments([null, 'custom'], 2, ' npm run dev ')).toEqual(['shell', 'custom:npm run dev'])
  })

  it('a custom placement with a blank command is a plain shell, not a launch of nothing', () => {
    expect(expandAssignments(['custom'], 1, '   ')).toEqual(['shell'])
  })

  it('pads to the count when slots run short', () => {
    expect(expandAssignments(['claude'], 3, '')).toEqual(['claude', 'shell', 'shell'])
  })
})

describe('normalizeSlots', () => {
  it('grows with empties and shrinks from the end', () => {
    expect(normalizeSlots(['a'], 3, '')).toEqual(['a', null, null])
    expect(normalizeSlots(['a', 'b', 'c'], 2, '')).toEqual(['a', 'b'])
  })

  it('drops custom placements while the command is blank', () => {
    expect(normalizeSlots(['custom', 'a'], 2, '')).toEqual([null, 'a'])
    expect(normalizeSlots(['custom', 'a'], 2, 'ls')).toEqual(['custom', 'a'])
  })
})

describe('the stepper contract', () => {
  it('grows into the FIRST empty slots', () => {
    expect(setSlotCount([null, 'b', null, null], 'a', 2)).toEqual(['a', 'b', 'a', null])
  })

  it('releases from the END, so up-then-down returns what you started with', () => {
    const start: SlotId[] = ['a', 'b', null, null]
    const up = setSlotCount(start, 'a', 3)
    expect(up).toEqual(['a', 'b', 'a', 'a'])
    expect(setSlotCount(up, 'a', 1)).toEqual(start)
  })

  it('never takes a slot from another provider', () => {
    expect(setSlotCount(['b', 'b'], 'a', 2)).toEqual(['b', 'b'])
  })

  it('is a no-op at the current count', () => {
    expect(setSlotCount(['a', null], 'a', 1)).toEqual(['a', null])
  })
})

describe('shell is the absence of an assignment, not a value', () => {
  it('fillAll with shell clears', () => {
    expect(fillAll(3, 'shell')).toEqual([null, null, null])
    expect(fillAll(2, 'claude')).toEqual(['claude', 'claude'])
  })

  it('fillEmpty leaves placed slots alone', () => {
    expect(fillEmpty(['a', null, 'b'], 'c')).toEqual(['a', 'c', 'b'])
    expect(fillEmpty([null, 'b'], 'shell')).toEqual([null, 'b'])
  })

  it('painting shell clears the slot', () => {
    expect(paintSlot(['a', 'b'], 1, 'shell')).toEqual(['a', null])
    expect(paintSlot(['a', 'b'], 0, 'c')).toEqual(['c', 'b'])
  })

  it('painting out of range changes nothing', () => {
    expect(paintSlot(['a'], 5, 'c')).toEqual(['a'])
    expect(paintSlot(['a'], -1, 'c')).toEqual(['a'])
  })
})

describe('a provider that left the machine cannot stay placed', () => {
  const installed = new Set(['claude'])

  it('drops the uninstalled, keeps custom', () => {
    expect(pruneToRoster(['claude', 'ghost', 'custom', null], installed)).toEqual(['claude', null, 'custom', null])
  })

  it('disarms an uninstalled brush but not shell or custom', () => {
    expect(pruneBrush('ghost', installed)).toBeNull()
    expect(pruneBrush('claude', installed)).toBe('claude')
    expect(pruneBrush('shell', installed)).toBe('shell')
    expect(pruneBrush('custom', installed)).toBe('custom')
  })

  it('restores a remembered lineup against what is installed', () => {
    expect(restoreLineup(['claude', 'ghost', 'shell'], installed, 3)).toEqual(['claude', null, null])
  })

  it('restoring clamps to the slots on offer', () => {
    expect(restoreLineup(['claude', 'claude', 'claude'], installed, 2)).toEqual(['claude', 'claude'])
  })
})

describe('counting', () => {
  it('counts placements and total assigned', () => {
    expect(countOf(['a', 'b', 'a', null], 'a')).toBe(2)
    expect(assignedTotal(['a', 'b', 'a', null])).toBe(3)
  })
})

describe('every function returns a NEW array', () => {
  // Both call sites mutated in place, which is what made this unassertable: a test could
  // not tell a no-op apart from a mutation it had missed.
  const input: SlotId[] = ['a', null]
  it.each([
    ['normalizeSlots', () => normalizeSlots(input, 2, '')],
    ['setSlotCount', () => setSlotCount(input, 'a', 1)],
    ['fillEmpty', () => fillEmpty(input, 'shell')],
    ['paintSlot', () => paintSlot(input, 9, 'a')],
    ['pruneToRoster', () => pruneToRoster(input, new Set(['a']))]
  ])('%s', (_name, run) => {
    expect(run()).not.toBe(input)
  })
})
