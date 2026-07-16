import { ABS_MAX_PANES } from '@contracts'
import { MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from './layout-tree'

/**
 * THE pane-capacity model: how many terminals a screen can honestly hold.
 *
 * The old world had one number (a hard 16) that pretended every monitor is the
 * same size. The honest limit is geometric: columns and rows are what fits the
 * screen at the pane minima (MIN_PANE_WIDTH_PX × MIN_PANE_HEIGHT_PX, seams
 * included), and the pane budget is their product — bounded above by the
 * contract's ABS_MAX_PANES, the slot-id space persistence guarantees. A bigger
 * monitor genuinely fits more terminals; a laptop fits fewer; nobody gets a
 * workspace whose panes cannot physically render at their floors.
 *
 * Every consumer asks THIS module — the wizard's painter (its lattice bounds),
 * the split/adopt gates in grid-layout, the controller's move/split refusals —
 * so the limit lives in exactly one place. `paneCapacity` is pure (unit-tested
 * against synthetic screens); `screenPaneCapacity` binds it to the real one.
 */

/** Seam width between panes (grid-layout's GUTTER + the panes' own borders). */
export const PANE_SEAM_PX = 4

export interface PaneCapacity {
  /** Columns that fit side by side at MIN_PANE_WIDTH_PX. */
  maxCols: number
  /** Rows that fit stacked at MIN_PANE_HEIGHT_PX. */
  maxRows: number
  /** The pane budget: cols × rows, hard-bounded by ABS_MAX_PANES. */
  maxPanes: number
}

/** Capacity for an arbitrary viewport — pure, so the model is testable. */
export function paneCapacity(availWidth: number, availHeight: number): PaneCapacity {
  const fit = (span: number, minimum: number): number =>
    Math.max(1, Math.floor((Math.max(0, span) + PANE_SEAM_PX) / (minimum + PANE_SEAM_PX)))
  const maxCols = fit(availWidth, MIN_PANE_WIDTH_PX)
  const maxRows = fit(availHeight, MIN_PANE_HEIGHT_PX)
  return { maxCols, maxRows, maxPanes: Math.min(maxCols * maxRows, ABS_MAX_PANES) }
}

/** Capacity of the screen the app lives on. Reads the OS work area (not the
 *  current window: the user can maximize any time, and "how many terminals may
 *  I have" should not flap with a half-snapped window). Falls back to a laptop
 *  panel when no screen is measurable (tests, headless). */
export function screenPaneCapacity(): PaneCapacity {
  const s = typeof window !== 'undefined' ? window.screen : undefined
  return paneCapacity(s?.availWidth || 1536, s?.availHeight || 864)
}
