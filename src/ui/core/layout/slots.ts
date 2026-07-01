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

/** Publish (or replace) the slots for one source (workspace id). */
export function publishSlots(source: string, slots: LayoutSlot[]): void {
  bySource.set(source, slots)
  const snapshot = all()
  for (const cb of subscribers) cb(snapshot)
}

/** Drop a source's slots entirely (e.g. a closed workspace). */
export function clearSlots(source: string): void {
  if (bySource.delete(source)) {
    const snapshot = all()
    for (const cb of subscribers) cb(snapshot)
  }
}

/** Subscribe to the aggregate slot set. Replayed immediately (order-independent). */
export function onSlots(cb: (slots: LayoutSlot[]) => void): () => void {
  subscribers.add(cb)
  cb(all())
  return () => subscribers.delete(cb)
}
