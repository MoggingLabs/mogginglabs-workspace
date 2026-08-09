/**
 * Does THIS MACHINE floor terminal cells at device pixels?
 *
 * xterm's two renderers disagree about cell WIDTH: the WebGL renderer computes
 * `floor(charWidth * dpr)` and the DOM renderer uses the raw product, so the same pane
 * proposes two different grids depending on which one happens to be attached. pane-fit
 * settles that by publishing the FLOORED cell unconditionally — except on a machine that
 * can never paint a pane with WebGL, where the floored grid would be one the DOM renderer
 * cannot fit, leaving a clipped strip at the right edge for the life of the app.
 *
 * WebGL AVAILABILITY is a legal input to that decision where a pane's CURRENT RENDERER is
 * not. Availability is session-stable and monotonic — you do not install a GPU under a
 * running app — whereas the attached renderer flips on events the user never caused (the
 * context cap, hidden-pane eviction, driver resets), so gating on it would mean
 * re-publishing a grid on every flip. That is the churn pane-fit exists to remove.
 *
 * One probe, at boot, released immediately: the context budget is ~16 app-wide
 * (pane-webgl's glBudget) and a probe that kept its context would spend one of them.
 */

// TRUE until proven otherwise, and the default is load-bearing exactly once: a pane that
// mounts before main.ts's prime. Every machine the app targets has WebGL, the pane budget
// already assumes it, and PANEFIT gates against the WebGL cell — so an un-primed read
// agrees with the common case rather than betting against it.
let floors = true
let primed = false

/** Run the one probe. Idempotent; called from the renderer bootstrap before `start()`,
 *  so every pane mounts with the answer already known. */
export function primeRendererProfile(): void {
  if (primed) return
  primed = true
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    floors = !!gl
    // Hand the context straight back. Without this the probe holds one of the ~16 for the
    // life of the app, and the pane that would have had it silently renders on DOM.
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // getContext can throw outright on a blocklisted driver — same answer as null.
    floors = false
  }
}

/** Whether a published cell should be floored at device pixels. False ONLY on a machine
 *  that can never paint with WebGL, which is the one case where the DOM renderer's raw
 *  cell is the truth rather than a transient. */
export function deviceFloorsCells(): boolean {
  return floors
}
