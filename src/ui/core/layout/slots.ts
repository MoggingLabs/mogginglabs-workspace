import type { PaneId } from '@contracts'

/**
 * The seam between the `layout` and `terminal` features. The layout feature PUBLISHES the
 * current set of slots (a slot = a pane id + the DOM element to render into); the terminal
 * feature SUBSCRIBES and fills each slot with a `TerminalPane`. Neither feature imports the
 * other — they meet only here (ui-core) + `@contracts` (see docs/04-adding-a-feature.md).
 */
export interface LayoutSlot {
  id: PaneId
  el: HTMLElement
}

let current: LayoutSlot[] = []
const subscribers = new Set<(slots: LayoutSlot[]) => void>()

/** Publish the current slot set (layout feature, on template/apply changes). */
export function publishSlots(slots: LayoutSlot[]): void {
  current = slots
  for (const cb of subscribers) cb(current)
}

/** Subscribe to slot changes. The current set is replayed immediately, so subscription is
 *  order-independent (layout and terminal can mount in either order). Returns an unsubscribe. */
export function onSlots(cb: (slots: LayoutSlot[]) => void): () => void {
  subscribers.add(cb)
  cb(current)
  return () => subscribers.delete(cb)
}
