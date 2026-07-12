import type { Terminal } from '@xterm/xterm'
import { icon } from '../../components'

/**
 * The pane slide bar, minimalist cut: ONLY the slider shows — no arrows, no
 * visible rail — a bright accent-orange pill (the focused-outline color)
 * floating just off the pane's right edge. It appears only when BOTH hold:
 * there is scrollback to scroll (`is-idle` hides it otherwise) and the mouse
 * is over the pane (CSS hover-reveal; a drag in flight keeps it visible even
 * if pointer capture leaves the pane). The full-height rail still exists
 * as an INVISIBLE hit area, so click-to-jump and drag work along the whole
 * edge. The jump pill: a small ⬇ floating near the bottom-RIGHT, shown only
 * once you've scrolled up; one tap returns to the latest output.
 *
 * Behavior is the PROVEN native model (macOS/Windows/VS Code terminal alike):
 * thumb length = visible/total ratio (clamped to a grabbable minimum), position
 * = scroll offset ratio, track press pages to the spot, drag maps linearly. The
 * thumb shrinking as scrollback grows is that standard, not a defect.
 *
 * Performance model — why "scroll all the way up" costs nothing:
 *  - Scrollback MEMORY is bounded: xterm keeps a ring buffer capped by the
 *    `scrollback` option (10k lines); old lines drop off. Nothing "loads" when
 *    you scroll — the lines are already in the ring, and only there.
 *  - RENDERING is viewport-only: xterm (WebGL or DOM) draws just the visible
 *    rows wherever you are in history. Scrolled to the top, it renders the same
 *    ~40 rows it renders at the bottom.
 *  - THIS bar is O(1): updates are rAF-coalesced off onScroll/onRender, the
 *    sync does no DOM reads (track height arrives from a ResizeObserver), and
 *    it skips the two style writes when the computed geometry didn't change —
 *    a long-running stream sitting at the bottom writes nothing at all.
 */

export interface PaneScrollbarHandle {
  dispose(): void
}

/** Grabbable floor for the thumb (the native standard: never a sliver). */
const MIN_THUMB_PX = 24

export function createPaneScrollbar(term: Terminal, body: HTMLElement): PaneScrollbarHandle {
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

  const onScroll = term.onScroll(schedule)
  const onRender = term.onRender(schedule) // buffer growth + refits move the thumb too
  const ro = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentBoxSize?.[0]
    trackH = box ? Math.round(box.blockSize) : track.clientHeight
    schedule()
  })
  ro.observe(track)
  schedule()

  // ── Interactions. pointerdown is prevented so the terminal keeps focus. ──
  const scrollToViewportY = (line: number): void => {
    const max = term.buffer.active.baseY
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
  tap(jump, () => term.scrollToBottom())

  return {
    dispose(): void {
      onScroll.dispose()
      onRender.dispose()
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
      slider.remove()
      jump.remove()
    }
  }
}
