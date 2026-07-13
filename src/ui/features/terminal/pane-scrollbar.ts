import type { Terminal } from '@xterm/xterm'
import { icon } from '../../components'
import type { PaneAnchorHandle } from './pane-anchor'

/**
 * The pane slide bar — an OVERLAY scrollbar, the macOS / VS Code / mobile model:
 * it costs zero layout, it is invisible at rest, and it appears only when it is
 * relevant to you. Three states reveal it, and nothing else does:
 *
 *   1. HOT    — the pointer is inside the bar's OWN lane at the right edge. This is the
 *               only hover that reveals it: being somewhere in the pane does not. The
 *               lane is an invisible hit strip (opacity 0 still hit-tests), so the bar
 *               is grabbable the instant the pointer arrives, with no dead frame.
 *   2. ACTIVE — the viewport is moving. Every overlay scrollbar in the industry flashes
 *               while you scroll (mid-flick, the position readout is exactly what you
 *               want) and fades ~900 ms after the motion stops.
 *   3. DRAG   — a scrub in flight keeps it lit even when pointer capture leaves the pane.
 * With scrollback but none of the three it is fully transparent; with no scrollback at
 * all (`is-idle`) it is not even displayed.
 *
 * Geometry is the proven native model: thumb length = visible/total (clamped to a
 * grabbable minimum), position = scroll offset, drag maps linearly, a track press pages
 * to the spot. The rail spans the pane's FULL height, so the ends mean what they say:
 * at the newest line the thumb sits flush on the floor, at the oldest flush against the
 * ceiling — no inset lying about how much history is left.
 *
 * Every interaction here is a human's, so each one tells the anchor (pane-anchor.ts):
 * scrubbing off the bottom stops the pane following its output, scrubbing back onto it
 * resumes it, and the jump pill re-arms it outright.
 *
 * Performance model — why "scroll all the way up" costs nothing:
 *  - Scrollback MEMORY is bounded: xterm keeps a ring buffer capped by the `scrollback`
 *    option (10k lines); old lines drop off. Nothing "loads" when you scroll.
 *  - RENDERING is viewport-only: xterm draws just the visible rows wherever you are.
 *  - THIS bar is O(1): rAF-coalesced, no DOM reads on the hot path (the track height
 *    arrives from a ResizeObserver), and it skips the two style writes when the computed
 *    geometry didn't change — a long stream sitting at the bottom writes nothing at all.
 */

export interface PaneScrollbarHandle {
  dispose(): void
}

/** Grabbable floor for the thumb (the native standard: never a sliver). */
const MIN_THUMB_PX = 24
/** How long the bar stays lit after the last scroll — the native overlay fade-out. */
const ACTIVE_MS = 900

export function createPaneScrollbar(term: Terminal, body: HTMLElement, anchor: PaneAnchorHandle): PaneScrollbarHandle {
  const mk = (cls: string): HTMLDivElement => {
    const d = document.createElement('div')
    d.className = cls
    return d
  }
  const btn = (cls: string, glyph: 'chevron-up' | 'chevron-down' | 'arrow-down', label: string, size: number): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = cls
    b.type = 'button'
    b.setAttribute('aria-label', label)
    b.title = label
    b.append(icon(glyph, size))
    return b
  }

  const thumb = mk('pane-slider-thumb')
  const track = mk('pane-slider-track')
  track.append(thumb)
  const slider = mk('pane-slider')
  slider.classList.add('is-idle')
  slider.append(track)

  const jump = btn('pane-jump', 'arrow-down', 'Jump to the latest output', 14)
  jump.hidden = true

  body.append(slider, jump)

  // ── Geometry. No DOM reads on the hot path: the track height is pushed here
  // by the ResizeObserver; sync is pure math + (at most) two style writes. ──
  let trackH = 0
  let lastTh = -1
  let lastY = -1
  let idle = true
  let jumpShown = false
  let raf = 0
  let activeTimer: ReturnType<typeof setTimeout> | undefined

  const sync = (): void => {
    raf = 0
    // xterm 6 buffers terminal row paints while DEC synchronized output mode
    // (CSI ? 2026 h) is active, but buffer/viewport scroll events still escape
    // immediately. Do not let our app-owned slider reveal that intermediate
    // geometry. ESU always requests a terminal refresh, whose onRender schedules
    // one final sync against the completed frame.
    if (term.modes.synchronizedOutputMode) return
    const buf = term.buffer.active
    const max = buf.baseY
    if (max <= 0) {
      if (!idle) {
        idle = true
        slider.classList.add('is-idle')
      }
      if (jumpShown) {
        jumpShown = false
        jump.hidden = true
      }
      return
    }
    if (idle) {
      idle = false
      slider.classList.remove('is-idle')
    }
    // The jump pill is the anchor's affordance: it shows exactly when the pane has
    // STOPPED following (you scrolled up), and one tap puts you back on the stream.
    const showJump = buf.viewportY < max
    if (showJump !== jumpShown) {
      jumpShown = showJump
      jump.hidden = !showJump
    }
    if (trackH <= 0) return
    const th = Math.max(MIN_THUMB_PX, Math.round((trackH * term.rows) / (max + term.rows)))
    const y = Math.round(((trackH - th) * buf.viewportY) / max)
    if (th === lastTh && y === lastY) return // at-bottom streaming lands here — zero writes
    lastTh = th
    lastY = y
    thumb.style.height = `${th}px`
    thumb.style.transform = `translateY(${y}px)`
  }
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(sync)
  }

  /** Light the bar for the scroll that just happened, then fade it back out.
   *
   *  Only for a scroll through HISTORY. A pane at the bottom of a streaming agent emits an
   *  onScroll for every line that arrives — flashing on those would leave the bar lit for as
   *  long as the agent is talking, which is the opposite of an overlay bar, and it would also
   *  paint into frames the terminal is holding atomic (DEC synchronized output): a TUI's
   *  repaint would tear around a bar sliding in. Nothing is being indicated at the bottom
   *  anyway — you are already where the newest output is. */
  const flash = (): void => {
    const buf = term.buffer.active
    if (buf.viewportY >= buf.baseY) return // at the newest line: nothing to say
    if (term.modes.synchronizedOutputMode) return // never paint into a held frame
    slider.classList.add('is-active')
    if (activeTimer) clearTimeout(activeTimer)
    activeTimer = setTimeout(() => {
      activeTimer = undefined
      slider.classList.remove('is-active')
    }, ACTIVE_MS)
  }

  const onScroll = term.onScroll(() => {
    schedule()
    flash()
  })
  const onRender = term.onRender(schedule) // buffer growth + refits move the thumb too
  // xterm's viewport scrolls NATIVELY: a wheel moves a real scrollable div and xterm syncs
  // its buffer from it, emitting NO onScroll. Without this, the single most common way
  // anyone scrolls — the wheel — would move the terminal without ever flashing the bar or
  // moving the thumb. Capture-phase because `scroll` does not bubble.
  const onNativeScroll = (): void => {
    schedule()
    flash()
  }
  body.addEventListener('scroll', onNativeScroll, true)
  const ro = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentBoxSize?.[0]
    trackH = box ? Math.round(box.blockSize) : track.clientHeight
    schedule()
  })
  ro.observe(track)
  schedule()

  // ── The lane's own hover. A :hover on the PANE would reveal the bar whenever the
  // pointer was anywhere in the terminal; the contract is the right-edge lane only.
  // Held as a class, not a :hover rule, so the reveal state is one thing — shared with
  // the active/drag states, and observable by the gate. ──
  slider.addEventListener('pointerenter', () => slider.classList.add('is-hot'))
  slider.addEventListener('pointerleave', () => slider.classList.remove('is-hot'))

  // ── Interactions. pointerdown is prevented so the terminal keeps focus. ──
  const scrollToViewportY = (line: number): void => {
    const max = term.buffer.active.baseY
    anchor.noteUserScroll() // a human's scroll: it may leave the bottom — or return to it
    term.scrollToLine(Math.max(0, Math.min(max, Math.round(line))))
  }

  let dragFrom: { y: number; viewportY: number } | null = null
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dragFrom = { y: e.clientY, viewportY: term.buffer.active.viewportY }
    thumb.setPointerCapture(e.pointerId)
    thumb.classList.add('is-dragging')
  })
  thumb.addEventListener('pointermove', (e) => {
    if (!dragFrom) return
    const range = trackH - lastTh
    if (range <= 0) return
    const lines = ((e.clientY - dragFrom.y) / range) * term.buffer.active.baseY
    scrollToViewportY(dragFrom.viewportY + lines)
  })
  const endDrag = (): void => {
    dragFrom = null
    thumb.classList.remove('is-dragging')
  }
  thumb.addEventListener('pointerup', endDrag)
  thumb.addEventListener('pointercancel', endDrag)

  track.addEventListener('pointerdown', (e) => {
    if (e.target === thumb) return
    e.preventDefault()
    // Centre the thumb where the press landed, like every native track.
    const rect = track.getBoundingClientRect()
    const ratio = (e.clientY - rect.top - lastTh / 2) / Math.max(1, rect.height - lastTh)
    scrollToViewportY(ratio * term.buffer.active.baseY)
  })

  const tap = (b: HTMLButtonElement, run: () => void): void => {
    b.addEventListener('pointerdown', (e) => e.preventDefault()) // keep the terminal focused
    b.addEventListener('click', () => {
      run()
      term.focus()
    })
  }
  tap(jump, () => anchor.stick()) // follow the stream again — not merely a one-shot scroll

  return {
    dispose(): void {
      onScroll.dispose()
      onRender.dispose()
      body.removeEventListener('scroll', onNativeScroll, true)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
      if (activeTimer) clearTimeout(activeTimer)
      slider.remove()
      jump.remove()
    }
  }
}
