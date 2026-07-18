import type { Terminal } from '@xterm/xterm'

/**
 * The pane scroll ANCHOR: a pane follows its newest output unless the USER chose
 * otherwise. Nothing else — not a replay, not a refit, not a reveal — may move the
 * viewport off the bottom.
 *
 * Why this exists. xterm keeps the viewport pinned while output arrives, but only for
 * output. Everything else that moves `baseY` under a viewport the user never touched
 * silently strands the pane in history:
 *  - a daemon reattach REPLAYS the whole scrollback into a pane whose grid is still
 *    the mount-time one, so the buffer grows by thousands of lines in a burst;
 *  - a hidden pane fits to a zero-height body (rows collapse), and the reveal's refit
 *    reflows the buffer under it;
 *  - a zoom/expand/layout change refits every sibling.
 * Any of these can land the viewport above the newest line, and the pane then just
 * SITS there — you enter a workspace and every conversation is scrolled to its top.
 * That is what this fixes, and it fixes it for every CLI (claude, codex, gemini, a
 * plain shell) because it is a property of the PANE, not of the agent: the anchor only
 * ever asks "did a human move this viewport?".
 *
 * The model is the one every terminal and chat client converges on ("stick to bottom"):
 *  - `following` starts true and is re-armed by typing and by the jump pill.
 *  - Only a real gesture — wheel, touch drag, a scroll key, the slide bar — may clear
 *    it, and it clears only if that gesture actually left the bottom. Scroll back down
 *    to the last line and you are following again.
 *  - While following, any scroll/render/resize that is NOT the user re-pins to the
 *    bottom on the next frame (rAF-coalesced; a no-op when already there).
 *
 * Two things make this safe, and both were learned the hard way (the PANESCROLL gate
 * caught each of them):
 *
 *  - INTENT IS A POSITION, NOT AN EVENT. xterm's viewport is a natively scrollable div:
 *    the wheel's default action moves it and xterm syncs its buffer from the scrollTop —
 *    often emitting NO `onScroll` at all. An anchor that decided from scroll events would
 *    simply never learn the user had left the bottom, and the next line of agent output
 *    would drag them back. So a gesture opens a short window, and when that window closes
 *    the anchor reads where the viewport actually came to REST. `onScroll`, when it does
 *    fire, is only an early confirmation of the same thing.
 *  - THE ANCHOR YIELDS WHILE A HUMAN IS DRIVING. Inside the window it does not touch the
 *    viewport at all. Otherwise a pin already queued for the current frame would land
 *    between the wheel and xterm's scroll sync and snap the viewport back — the user's
 *    wheel would appear to do nothing.
 *  - A GESTURE CARRIES A DIRECTION. Yielding is not believing: while the window is open
 *    the machine keeps writing (a repaint, a replay, a refit), and the displacement THAT
 *    produces comes to rest exactly where a human's would. So each gesture also records
 *    whether the human ever pointed UP — a wheel tick with negative delta, a finger
 *    dragging down, a PageUp/Home/ArrowUp chord; a scrollbar scrub is trusted outright,
 *    its rest position IS the intent. At rest, an off-bottom viewport releases the anchor
 *    only if the gesture actually pointed up. Without this, an incidental down-tick over
 *    a pane whose CLI then repaints (Windows delivers the wheel to whatever unfocused
 *    window the pointer happens to rest over) had its machine displacement attributed to
 *    the human, and the pane sat stranded in the blank scrollback that same repaint had
 *    just created. Direction renews with the window: trackpad inertia trains keep one
 *    gesture — and one intent — alive across their whole run.
 *
 * Typing is read from real key events on the pane, NOT from `onData`: xterm answers
 * CPR/DA/focus queries through the same `onData` channel, and agents poll those
 * constantly — an anchor re-armed by them would yank a user who had deliberately
 * scrolled up back to the bottom, on the agent's schedule.
 */

export interface PaneAnchorHandle {
  /** True while the pane is following the newest output. */
  following(): boolean
  /** Follow the newest output again, now (typing, the jump pill, an explicit reveal). */
  stick(): void
  /** A human is driving the viewport with an exact target (a scrollbar scrub): wherever
   *  this gesture comes to rest is where they meant to be, and it decides `following`. */
  noteUserScroll(): void
  /** Re-pin if we are following and something moved us off the bottom. */
  pin(): void
  /** Counters for the PANESCROLL gate: which paths actually fired. */
  debug(): { gestures: number; scrolls: number; inWindow: number; repins: number; settles: number; overrides: number }
  dispose(): void
}

/** How long after a gesture a scroll still counts as that gesture's. Covers the wheel's
 *  own inertia/coalescing without swallowing the replay bursts we are guarding against. */
const GESTURE_MS = 400

export function createPaneAnchor(term: Terminal, body: HTMLElement): PaneAnchorHandle {
  let follow = true
  let gestureUntil = 0
  let intentUp = false
  let gestureFollow = true // `follow` as the current gesture found it
  let raf = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  const dbg = { gestures: 0, scrolls: 0, inWindow: 0, repins: 0, settles: 0, overrides: 0 }

  const atBottom = (): boolean => {
    const b = term.buffer.active
    return b.viewportY >= b.baseY
  }

  /** Where a gesture's dust settles, this is the verdict: at the bottom always follows;
   *  off the bottom counts as the human's choice if the gesture pointed up; and a gesture
   *  that never pointed up leaves `following` exactly as it found it — a pane that was
   *  following stays following (the displacement was the machine's: a repaint/replay/
   *  reflow landing inside the window), and a reader already parked in history who nudges
   *  DOWN without reaching the bottom is not yanked there. */
  const decide = (): boolean => atBottom() || (intentUp ? false : gestureFollow)

  const repin = (): void => {
    raf = 0
    // While a human is driving, the anchor does not touch the viewport. Without this the
    // pin RACES the gesture: a wheel's scroll is delivered asynchronously (the browser
    // scrolls the viewport, xterm syncs its buffer from it, and only THEN does onScroll
    // fire), so a pin already queued for this frame would snap back to the bottom before
    // the scroll that was supposed to release the anchor was ever seen — and the user's
    // wheel would do nothing at all. Yield for the window; the gesture's own scroll then
    // decides whether we are still following.
    if (Date.now() <= gestureUntil) return
    // Never move the viewport mid-frame. xterm 6 holds row paints while DEC synchronized
    // output (CSI ? 2026 h) is active so a TUI's repaint lands as ONE atomic frame — but a
    // scroll still takes effect immediately, so re-pinning here would tear the very frame
    // the mode exists to protect: the pane would show a half-drawn codex repaint. The ESU
    // that ends the frame always requests a refresh, and its onRender calls us right back —
    // against the completed frame. (FLICKER's pixel-atomicity check caught this.)
    if (term.modes.synchronizedOutputMode) return
    if (follow && !atBottom()) {
      dbg.repins++
      term.scrollToBottom()
    }
  }
  const pin = (): void => {
    // The hot path is a pane that is already where it should be: sixteen agents streaming,
    // every one of them at the bottom and following. Scheduling a frame callback to discover
    // that costs a rAF per pane per render — thousands of no-op callbacks a second across a
    // full grid, on the exact path the perception budget (docs/07) is measured on. The two
    // buffer reads that answer "is there anything to do?" are cheaper than the callback that
    // would answer it later, so ask now and schedule nothing.
    // (A pane the user has scrolled away from has nothing to do either: repin would find
    // `follow` false and return. Both no-op cases are answered here, before the frame.)
    if (!follow || atBottom()) return
    if (!raf) raf = requestAnimationFrame(repin)
  }

  const noteGesture = (up: boolean): void => {
    dbg.gestures++
    const now = Date.now()
    if (now > gestureUntil) {
      intentUp = false // a fresh gesture starts with no direction...
      gestureFollow = follow // ...and remembers the state it found, to leave it undisturbed
    }
    if (up) intentUp = true // any 'up' the gesture expresses is kept for its whole run
    gestureUntil = now + GESTURE_MS
    if (raf) {
      cancelAnimationFrame(raf) // drop a pin queued before the gesture landed
      raf = 0
    }
    // The POSITION the gesture comes to rest at is what decides — never an event.
    // xterm's viewport scrolls NATIVELY (the wheel's default action moves a real
    // scrollable div, and xterm syncs its buffer from that), so a wheel can move the
    // user through history without ever emitting `onScroll`. An anchor that only
    // listened to scroll events would never notice they had left the bottom, and the
    // very next line of agent output would drag them back down. So: when the gesture
    // window closes, look at where the viewport actually IS — read through `decide`,
    // so a machine displacement inside the window is never mistaken for the human's.
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = undefined
      follow = decide()
      if (follow && !atBottom()) dbg.overrides++ // machine displacement overruled
      dbg.settles++
      pin()
    }, GESTURE_MS + 20)
  }
  const noteUserScroll = (): void => noteGesture(true) // an exact scrub: trust where it rests

  const stick = (): void => {
    follow = true
    gestureUntil = 0
    if (settle) {
      clearTimeout(settle) // an explicit "follow again" outranks the gesture still settling
      settle = undefined
    }
    if (!atBottom()) term.scrollToBottom()
  }

  const onScroll = term.onScroll(() => {
    dbg.scrolls++
    if (Date.now() <= gestureUntil) {
      dbg.inWindow++
      follow = decide() // the human decides — where the gesture pointed where it rests
    } else pin() // anything else: the anchor holds
  })
  // Writes AND reflows land here — the reattach replay and the reveal refit both do.
  const onRender = term.onRender(pin)
  const onResize = term.onResize(pin)

  // Gestures. Capture-phase and passive: we only ever OBSERVE them, xterm still handles
  // them. `wheel` covers trackpads too; `touchmove` the touch drag. Each reports the one
  // thing an event can say that a rest position cannot: which way the human pointed.
  const gesture = { capture: true, passive: true } as const
  // Ctrl+wheel is the pinch-zoom gesture, not a scroll: it still opens the window (the
  // anchor yields to whatever it does) but claims no direction.
  const onWheel = (e: WheelEvent): void => noteGesture(!e.ctrlKey && e.deltaY < 0)
  // A finger dragging DOWN scrolls the content up, into history.
  let touchY: number | undefined
  const onTouch = (e: TouchEvent): void => {
    const y = e.touches[0]?.clientY
    const up = Date.now() <= gestureUntil && touchY !== undefined && y !== undefined && y > touchY
    touchY = y
    noteGesture(up)
  }
  body.addEventListener('wheel', onWheel, gesture)
  body.addEventListener('touchmove', onTouch, gesture)

  // Keys: the scroll chords are a gesture (they may leave the bottom deliberately);
  // every other key is TYPING, which means the user is talking to the agent at the
  // prompt — xterm's own scrollOnUserInput already jumps there, so re-arm with it.
  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'])
  const UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])
  const onKey = (e: KeyboardEvent): void => {
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && SCROLL_KEYS.has(e.key)) noteGesture(UP_KEYS.has(e.key))
    else if (!e.ctrlKey && !e.metaKey && !e.altKey) stick() // typing = back to the prompt
  }
  body.addEventListener('keydown', onKey, true)

  return {
    following: () => follow,
    debug: () => ({ ...dbg }),
    stick,
    noteUserScroll,
    pin,
    dispose(): void {
      onScroll.dispose()
      onRender.dispose()
      onResize.dispose()
      body.removeEventListener('wheel', onWheel, gesture)
      body.removeEventListener('touchmove', onTouch, gesture)
      body.removeEventListener('keydown', onKey, true)
      if (settle) clearTimeout(settle)
      if (raf) cancelAnimationFrame(raf)
    }
  }
}
