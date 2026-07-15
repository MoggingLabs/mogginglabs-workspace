import type { PaneId } from '@contracts'

/**
 * The seam between the `layout`/`workspace` features and `terminal`. Each layout source (a
 * workspace) PUBLISHES its slots (slot = a pane id + the DOM element to render into); the
 * terminal feature SUBSCRIBES to the AGGREGATE of all sources and fills each slot with a
 * `TerminalPane`. Multiple sources coexist (all panes stay mounted; switching workspaces is
 * just show/hide), and no feature imports another — they meet only here + `@contracts`.
 */
export interface LayoutSlot {
  id: PaneId
  el: HTMLElement
}

const bySource = new Map<string, LayoutSlot[]>()
const subscribers = new Set<(slots: LayoutSlot[]) => void>()

const all = (): LayoutSlot[] => Array.from(bySource.values()).flat()

let batchDepth = 0
let batchDirty = false

function notify(): void {
  // Inside a batch the aggregate is MID-EDIT and must not be shown to anyone. The
  // terminal feature destroys (and KILLS the PTY of) every pane id missing from the
  // set it is handed, so a moment where a moving pane belongs to neither workspace is
  // not a cosmetic flicker — it is the agent dying. See `batchSlots`.
  if (batchDepth > 0) {
    batchDirty = true
    return
  }
  const snapshot = all()
  for (const cb of subscribers) cb(snapshot)
}

/**
 * Run `fn` with slot notifications held, then publish ONCE at the end.
 *
 * This exists for cross-workspace pane moves. A move is two publishes — the source
 * drops the slot, the destination gains it — and the subscriber only ever sees the
 * AGGREGATE. Published separately, the aggregate between them is missing the pane, and
 * the terminal reconciler reads a missing id as "this pane is gone", disposes it and
 * kills its PTY. Batched, the id never leaves the aggregate at all: it changes which
 * source owns it, which is precisely what a move is.
 *
 * Re-entrant (depth-counted) and exception-safe — a throwing `fn` still releases.
 */
export function batchSlots<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    if (batchDepth === 0 && batchDirty) {
      batchDirty = false
      notify()
    }
  }
}

/** Publish (or replace) the slots for one source (workspace id). */
export function publishSlots(source: string, slots: LayoutSlot[]): void {
  bySource.set(source, slots)
  notify()
}

/** Drop a source's slots entirely (e.g. a closed workspace). */
export function clearSlots(source: string): void {
  if (bySource.delete(source)) notify()
}

/**
 * Is this pane id live in ANY workspace right now?
 *
 * Pane ids used to be a pure function of the workspace (`ordinal * 100 + slot`), so a
 * workspace could allocate inside its own range and never collide. A pane that MOVES
 * keeps its id — that is what keeps its daemon session, and everything keyed on it,
 * alive — so its old workspace now has a free slot whose formula id is somebody else's
 * live pane. Allocation asks here instead of trusting the formula: handing that id out
 * twice would point two panes at one daemon session (the reused-id class of bug the
 * daemon's `gen` stamp exists to survive — this prevents it from being minted at all).
 */
export function paneIdInUse(id: PaneId): boolean {
  for (const slots of bySource.values()) {
    for (const slot of slots) if (slot.id === id) return true
  }
  return false
}

/** Subscribe to the aggregate slot set. Replayed immediately (order-independent). */
export function onSlots(cb: (slots: LayoutSlot[]) => void): () => void {
  subscribers.add(cb)
  cb(all())
  return () => subscribers.delete(cb)
}
