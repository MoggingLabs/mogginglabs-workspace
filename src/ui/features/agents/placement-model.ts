/**
 * The PLACEMENT ALGEBRA — what runs in each terminal, as pure data.
 *
 * The wizard and the "New terminals" modal ask the same question over different canvases
 * (a whole new grid vs. the panes being added to a live one), and they used to answer it
 * with two verbatim copies of this arithmetic. It lives here once, framework-free, so the
 * rules that are easy to get subtly wrong — the stepper growing into the FIRST empty slot
 * and releasing from the END, a blank custom command falling back to a shell, a provider
 * that left the machine losing its placements — are stated once and tested once.
 *
 * Every function returns a NEW array. Both call sites mutated in place, which is what made
 * the behaviour unassertable: a test could not tell a no-op from a mutation it had missed.
 */

/** What terminal k runs: a roster id · `'custom'` · null for a plain shell. */
export type SlotId = string | null

export function countOf(slots: readonly SlotId[], id: string): number {
  return slots.filter((s) => s === id).length
}

export function assignedTotal(slots: readonly SlotId[]): number {
  return slots.filter(Boolean).length
}

/** Resize to `count`, and drop `'custom'` placements while the command line is blank —
 *  a placement that would launch nothing must not read as a placement. */
export function normalizeSlots(slots: readonly SlotId[], count: number, customCmd: string): SlotId[] {
  const n = Math.max(0, Math.floor(count) || 0)
  const sized =
    slots.length < n ? [...slots, ...Array<SlotId>(n - slots.length).fill(null)] : slots.slice(0, n)
  return customCmd.trim() ? sized : sized.map((id) => (id === 'custom' ? null : id))
}

/** The launch manifest, SLOT-ORDERED: terminal k runs what was painted on terminal k. */
export function expandAssignments(slots: readonly SlotId[], count: number, customCmd: string): string[] {
  const cmd = customCmd.trim()
  return Array.from({ length: Math.max(0, Math.floor(count) || 0) }, (_, i) => {
    const id = slots[i]
    if (!id) return 'shell'
    if (id === 'custom') return cmd ? `custom:${cmd}` : 'shell'
    return id
  })
}

/**
 * Grow or shrink `id` to exactly `n` placements. New ones take the FIRST empty slots and
 * releases come off the END — so nudging a stepper up and back down returns the lineup you
 * started with, instead of walking assignments across the grid.
 */
export function setSlotCount(slots: readonly SlotId[], id: string, n: number): SlotId[] {
  const next = [...slots]
  let current = countOf(next, id)
  for (let i = next.length - 1; current > n && i >= 0; i--) {
    if (next[i] === id) {
      next[i] = null
      current--
    }
  }
  for (let i = 0; current < n && i < next.length; i++) {
    if (next[i] === null) {
      next[i] = id
      current++
    }
  }
  return next
}

/** `'shell'` is the ABSENCE of an assignment, not a value — it clears rather than fills. */
const placed = (id: string): SlotId => (id === 'shell' ? null : id)

export function fillAll(count: number, id: string): SlotId[] {
  return Array<SlotId>(Math.max(0, Math.floor(count) || 0)).fill(placed(id))
}

export function fillEmpty(slots: readonly SlotId[], id: string): SlotId[] {
  return slots.map((s) => s ?? placed(id))
}

export function paintSlot(slots: readonly SlotId[], i: number, brush: string): SlotId[] {
  if (i < 0 || i >= slots.length) return [...slots]
  const next = [...slots]
  next[i] = placed(brush)
  return next
}

/** A provider that left the machine cannot stay placed: a launch would type a command the
 *  shell cannot find. `'custom'` survives — it names the command line, not an install. */
export function pruneToRoster(slots: readonly SlotId[], installed: ReadonlySet<string>): SlotId[] {
  return slots.map((id) => (id && id !== 'custom' && !installed.has(id) ? null : id))
}

export function pruneBrush(brush: SlotId, installed: ReadonlySet<string>): SlotId {
  if (!brush || brush === 'custom' || brush === 'shell') return brush
  return installed.has(brush) ? brush : null
}

/** The remembered lineup, restored against what is still installed and clamped to the
 *  slots on offer. Anything unrecognised degrades to a plain shell rather than vanishing,
 *  so the count the user last chose still comes back. */
export function restoreLineup(
  saved: readonly string[],
  installed: ReadonlySet<string>,
  count: number
): SlotId[] {
  return Array.from({ length: Math.max(0, Math.floor(count) || 0) }, (_, i) => {
    const id = saved[i]
    return id && id !== 'shell' && installed.has(id) ? id : null
  })
}
