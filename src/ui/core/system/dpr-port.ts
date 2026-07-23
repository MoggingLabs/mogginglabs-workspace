/**
 * Device-pixel-ratio change notifications — the metrics trigger no box observer sees.
 *
 * Dragging the window to a monitor with a different display scale (or an Electron zoom
 * change) alters devicePixelRatio while every element's CSS box stays identical: no
 * ResizeObserver fires, yet under the WebGL renderer the effective cell width changes
 * (cells are floored at device pixels), so the correct terminal grid changes. xterm
 * re-rasterizes its own glyphs on dpr change; re-deriving the GRID is the app's job,
 * and this port is its trigger.
 *
 * The standard re-arming matchMedia pattern (an event, never a poll): a `resolution`
 * query matches exactly one ratio, so each firing re-arms at the new one. Same
 * subscribe shape as theme-port/font-port: one window-level listener, per-consumer
 * unsubscribers.
 */

const subscribers = new Set<() => void>()
let armed = false

function arm(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  mq.addEventListener(
    'change',
    () => {
      for (const cb of subscribers) cb()
      arm() // the old query is now permanently false — listen at the NEW ratio
    },
    { once: true }
  )
}

/** Subscribe to dpr changes (no immediate replay — the current ratio is already what
 *  every consumer measured against). Returns unsubscribe. */
export function onDevicePixelRatioChange(cb: () => void): () => void {
  subscribers.add(cb)
  if (!armed) {
    armed = true
    arm()
  }
  return () => subscribers.delete(cb)
}
