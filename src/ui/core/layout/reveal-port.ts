/**
 * Pane-reveal notifications — the uncover trigger no box observer sees.
 *
 * Expand covers siblings via `visibility: hidden` and restore uncovers them, all
 * without a single box changing — so neither ResizeObserver nor IntersectionObserver
 * fires (grid-layout.ts's expand contract; FLICKER's dwell phase pins that silence).
 * That silence is load-bearing for cheapness, but it also meant a pane whose xterm
 * grid drifted while covered had NO future trigger to correct it — the grid-drift
 * incident, and the GRIDHEAL gate's reveal phase.
 *
 * GridLayout.reflow() is the one place that knows a slot flipped covered → visible;
 * it publishes the revealed panes here, and each pane answers with a plain refit()
 * (deduped — an unchanged grid costs nothing, which is what keeps FLICKER's
 * zero-sibling-resize budget intact).
 *
 * Same subscribe shape as dpr-port: module-level listener set, per-consumer
 * unsubscribers (panes are disposed; the port is app-lifetime).
 */

type Listener = (paneIds: readonly number[]) => void

const subscribers = new Set<Listener>()

/** GridLayout's side: these panes just flipped covered → visible in a reflow. */
export function notifyPanesRevealed(paneIds: readonly number[]): void {
  if (!paneIds.length) return
  for (const cb of subscribers) cb(paneIds)
}

/** Subscribe to reveals (no replay — a reveal is an instant, not a state). Returns
 *  unsubscribe. */
export function onPanesRevealed(cb: Listener): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
