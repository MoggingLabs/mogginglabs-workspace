/**
 * App-wide OVERLAY scrollbars — the same contract the terminal panes ship, applied to
 * every scrollable surface in the app (settings, explorer, file tree, board, rail, menus):
 *
 *   invisible at rest → visible while you are scrolling → visible when the pointer is in
 *   the bar's own lane at the container's edge.
 *
 * Being *in the lane* is the whole point, and it is why this is JavaScript rather than
 * three lines of CSS. CSS can only offer `:hover` on the whole container, which reveals a
 * bar whenever the pointer is anywhere inside it — that is not the contract; it is the
 * thing the contract rejects. So the pointer's distance from the edge is measured here,
 * and the styling stays declarative: this file only ever sets two classes.
 *
 * Cost. Exactly two delegated listeners for the entire app, no per-container wiring, and
 * no work on the frames that matter:
 *  - `scroll` is capture-phase (scroll does not bubble) and does nothing but set a class
 *    and reset a timer — no geometry, no layout read.
 *  - `pointermove` is throttled to at most once a frame and bails immediately on the common
 *    case (the pointer is not over a scrollable thing, or the class is already right). The
 *    one layout read (`getBoundingClientRect`) happens only while the pointer is actually
 *    over a container that can scroll. The throttle is a TIME floor, deliberately not
 *    requestAnimationFrame: rAF only runs while the page paints, and a bar that waits for
 *    the next repaint to notice your pointer is not a bar that responds to it.
 * Both are passive, so neither can delay a scroll.
 *
 * Terminal panes opt OUT: they have their own bar (pane-scrollbar.ts), which is a real
 * element rather than a native scrollbar — it can be dragged, click-paged and flashed on
 * a wheel that emits no scroll event at all. Two bars on one surface would be a bug.
 */

/** How wide the reveal lane is at the container's edge (matches the pane bar's lane). */
const LANE_PX = 14
/** How long the bar stays lit after the last scroll — the native overlay fade-out. */
const FLASH_MS = 900

/** At-most-once-a-frame budget for the lane test, without depending on the frame loop. */
const FRAME_MS = 16

const HOT = 'ovs-hot'
const SCROLLING = 'ovs-scrolling'

/** Does this element actually scroll? (An `overflow: auto` box with nothing to scroll has
 *  no bar to reveal, and must not light up when the pointer drifts near its edge.) */
const scrollsY = (el: Element): boolean => {
  if (el.scrollHeight <= el.clientHeight + 1) return false
  const oy = getComputedStyle(el).overflowY
  return oy === 'auto' || oy === 'scroll'
}
const scrollsX = (el: Element): boolean => {
  if (el.scrollWidth <= el.clientWidth + 1) return false
  const ox = getComputedStyle(el).overflowX
  return ox === 'auto' || ox === 'scroll'
}

/** The terminal owns its own bar — never give a pane a second one. */
const isTerminalSurface = (el: Element): boolean => !!el.closest('.pane-body')

export function installOverlayScrollbars(doc: Document = document): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  let hot: Element | null = null
  let queued = false
  let lastEval = 0
  let trailing: ReturnType<typeof setTimeout> | undefined
  let last: { x: number; y: number; target: Element | null } = { x: 0, y: 0, target: null }

  // ── Scrolling lights the bar, then it fades. Capture-phase: `scroll` does not bubble.
  const onScroll = (e: Event): void => {
    const el = e.target as Element | null
    if (!el || !(el instanceof Element) || isTerminalSurface(el)) return
    el.classList.add(SCROLLING)
    const prev = timers.get(el)
    if (prev) clearTimeout(prev)
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el)
        el.classList.remove(SCROLLING)
      }, FLASH_MS)
    )
  }

  // ── The lane. Reveal only while the pointer is within LANE_PX of the scrolling edge.
  const evaluate = (): void => {
    queued = false
    const { x, y, target } = last
    let next: Element | null = null

    for (let el = target; el && el !== doc.documentElement; el = el.parentElement) {
      if (isTerminalSurface(el)) break
      const inLaneY = scrollsY(el)
      const inLaneX = !inLaneY && scrollsX(el)
      if (!inLaneY && !inLaneX) continue
      const r = el.getBoundingClientRect()
      const hitY = inLaneY && x >= r.right - LANE_PX && x <= r.right && y >= r.top && y <= r.bottom
      const hitX = inLaneX && y >= r.bottom - LANE_PX && y <= r.bottom && x >= r.left && x <= r.right
      if (hitY || hitX) next = el
      break // the innermost scrollable under the pointer owns the lane
    }

    if (next === hot) return
    hot?.classList.remove(HOT)
    next?.classList.add(HOT)
    hot = next
  }

  // Throttled on TIME, not on requestAnimationFrame. rAF is the reflex reach for "do this
  // at most once a frame", but it only runs when the page is actually painting — an idle
  // or occluded window starves it, and a bar that appears only once something else happens
  // to repaint the page is not a bar that responds to your pointer. A 16ms floor with a
  // trailing call gives the same at-most-once-a-frame budget and owes nothing to the
  // compositor. (The APPSCROLL gate caught this: the lane never lit.)
  const onMove = (e: PointerEvent): void => {
    last = { x: e.clientX, y: e.clientY, target: e.target as Element | null }
    const now = Date.now()
    if (now - lastEval >= FRAME_MS) {
      lastEval = now
      evaluate()
    } else if (!queued) {
      queued = true
      trailing = setTimeout(() => {
        lastEval = Date.now()
        evaluate() // clears `queued`
      }, FRAME_MS)
    }
  }

  // The pointer leaving the window can never produce a `pointermove` that clears the lane.
  const onLeave = (): void => {
    hot?.classList.remove(HOT)
    hot = null
  }

  ;(window as unknown as { __ovs?: boolean }).__ovs = true // liveness marker for the APPSCROLL gate
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('pointermove', onMove, { capture: true, passive: true })
  doc.addEventListener('pointerleave', onLeave, { capture: true, passive: true })

  return (): void => {
    if (trailing) clearTimeout(trailing)
    doc.removeEventListener('scroll', onScroll, true)
    doc.removeEventListener('pointermove', onMove, true)
    doc.removeEventListener('pointerleave', onLeave, true)
    hot?.classList.remove(HOT)
    hot = null
  }
}
