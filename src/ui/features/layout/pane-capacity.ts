import { ABS_MAX_PANES, type MachineSpec } from '@contracts'
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
 *  panel when no screen is measurable (tests, headless).
 *
 *  `host` is the element the panes would actually live in (the shell's content
 *  region / a workspace's grid viewport). When given, the app's own CHROME —
 *  titlebar, rail, docks, paddings: everything between the window edge and that
 *  element — is subtracted from the work area, because the promise is what a
 *  MAXIMIZED window's grid region can hold, not what the bare monitor could.
 *  Chrome is measured against the live window (its size is snap-independent);
 *  a hidden or unmounted host (zero box) falls back to the bare screen. */
export function screenPaneCapacity(host?: HTMLElement | null): PaneCapacity {
  const s = typeof window !== 'undefined' ? window.screen : undefined
  let availWidth = s?.availWidth || 1536
  let availHeight = s?.availHeight || 864
  if (host && typeof window !== 'undefined') {
    const box = host.getBoundingClientRect()
    if (box.width > 0 && box.height > 0) {
      availWidth = Math.max(1, availWidth - Math.max(0, window.innerWidth - box.width))
      availHeight = Math.max(1, availHeight - Math.max(0, window.innerHeight - box.height))
    }
  }
  return paneCapacity(availWidth, availHeight)
}

// ── The RESOURCE budget: what the MACHINE can honestly run ─────────────────────
//
// A pane is not pixels — it is a PTY, a shell, and usually an agent CLI: a node
// process that commonly sits at 200–500 MiB under load, plus xterm's scrollback
// and (for the first ~16 panes) a WebGL context. A screen-only cap happily offers
// 32 terminals on an 8 GiB laptop, and 32 busy agents there is a machine on its
// knees. So the budget has a second dimension, from two measurements
// (system:machine — main measures, THIS module decides):
//
//   memory   (totalMemMb − MACHINE_RESERVE_MB) / PANE_BUDGET_MB
//            512 MiB per pane errs on the heavy side of a working agent, so the
//            number we OFFER is one the machine can survive at full tilt;
//            4 GiB stays reserved for the OS, this app, and the browser docks.
//   cpu      PANES_PER_CORE × logical cores — agents burst whole cores; two per
//            core keeps the machine interactive when several burst together.
//
// min of the two, clamped to [1, ABS_MAX_PANES]. GPU is deliberately NOT a count
// limit: Chromium caps live WebGL contexts (~16) and PaneWebglManager already
// rides the DOM renderer past that edge — correct, just not GPU-smooth.
/** MiB one agent-grade terminal is budgeted to cost at full tilt. */
export const PANE_BUDGET_MB = 512
/** MiB held back for the OS, this app's own processes, and the docks. */
export const MACHINE_RESERVE_MB = 4096
/** Concurrent panes per logical core that keep the machine interactive. */
export const PANES_PER_CORE = 2

/** The machine-wide pane budget — pure, so the model is testable. */
export function machinePaneBudget(spec: MachineSpec): number {
  const byMemory = Math.floor((Math.max(0, spec.totalMemMb) - MACHINE_RESERVE_MB) / PANE_BUDGET_MB)
  const byCpu = Math.max(1, Math.floor(spec.cpuCount)) * PANES_PER_CORE
  return Math.max(1, Math.min(byMemory, byCpu, ABS_MAX_PANES))
}

/** Why a budget stopped where it did — the wizard's hint says this in words. */
export type PaneLimitReason = 'screen' | 'memory' | 'cpu' | 'ceiling'

export interface PaneBudget extends PaneCapacity {
  /** What bound `maxPanes`: the screen's geometry, or the machine itself. */
  limitedBy: PaneLimitReason
  /** What the screen ALONE would allow — for copy that says what the machine cost. */
  screenMaxPanes: number
  /** The machine-wide budget before subtracting running panes (null = unknown). */
  machineMaxPanes: number | null
  /** Panes already running (all workspaces) that were charged against it. */
  panesElsewhere: number
  /** Echo of the measurements, for honest copy ("12 cores · 16 GB"). */
  machine: MachineSpec | null
}

/**
 * THE pane budget: geometry ∧ machine, minus what is already running.
 *
 * Terminals in other workspaces spend the same RAM/CPU a new one would, so the
 * machine-side term is charged for them (`panesElsewhere`, floored at 1 — you
 * may always open ONE terminal). A null `spec` (channel not answered yet, tests)
 * degrades to the geometry-only world. One function, every consumer: the
 * wizard's lattice, GridLayout's split/adopt gates, the move-picker's refusals —
 * two different numbers would gate one door twice.
 */
export function effectivePaneCapacity(
  host?: HTMLElement | null,
  spec?: MachineSpec | null,
  panesElsewhere = 0
): PaneBudget {
  const geometry = screenPaneCapacity(host)
  const machineMax = spec ? machinePaneBudget(spec) : null
  const headroom = machineMax === null ? null : Math.max(1, machineMax - Math.max(0, Math.floor(panesElsewhere)))
  const maxPanes = headroom === null ? geometry.maxPanes : Math.min(geometry.maxPanes, headroom)
  let limitedBy: PaneLimitReason = 'screen'
  if (headroom !== null && headroom < geometry.maxPanes && spec) {
    const byMemory = Math.floor((Math.max(0, spec.totalMemMb) - MACHINE_RESERVE_MB) / PANE_BUDGET_MB)
    const byCpu = Math.max(1, Math.floor(spec.cpuCount)) * PANES_PER_CORE
    limitedBy = byMemory <= byCpu ? (byMemory < ABS_MAX_PANES ? 'memory' : 'ceiling') : byCpu < ABS_MAX_PANES ? 'cpu' : 'ceiling'
  } else if (maxPanes === ABS_MAX_PANES) {
    limitedBy = 'ceiling'
  }
  return {
    ...geometry,
    maxPanes,
    limitedBy,
    screenMaxPanes: geometry.maxPanes,
    machineMaxPanes: machineMax,
    panesElsewhere: Math.max(0, Math.floor(panesElsewhere)),
    machine: spec ?? null
  }
}
