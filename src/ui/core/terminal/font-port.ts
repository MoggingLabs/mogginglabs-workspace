/**
 * Terminal type (Phase-5/06). ONE user-facing knob: fontSize (12–16px, Settings §
 * Terminal), applied LIVE to every open pane through the house remeasure→refit
 * pipeline and read by new panes at construction. Line-height is FIXED by design
 * (one fewer footgun; the value is the empirical pick from the 5/06 type matrix).
 * Same decoupling pattern as theme-port: settings sets, panes subscribe, the
 * latest value replays to late subscribers.
 */

const KEY = 'mogging.terminalFontSize'

export const TERMINAL_FONT_SIZES = [12, 13, 14, 15, 16] as const
/** Empirical default — see docs/11-design-system.md § Terminal type. */
export const DEFAULT_TERMINAL_FONT_SIZE = 14
/** Fixed multiplier — chosen with the size in the 5/06 matrix, not user-facing. */
export const TERMINAL_LINE_HEIGHT = 1.3

function clamp(n: number): number {
  return (TERMINAL_FONT_SIZES as readonly number[]).includes(n) ? n : DEFAULT_TERMINAL_FONT_SIZE
}

function read(): number {
  try {
    const raw = localStorage.getItem(KEY)
    return clamp(raw ? Number(raw) : DEFAULT_TERMINAL_FONT_SIZE)
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE
  }
}

let current = read()
const subscribers = new Set<(size: number) => void>()

export function terminalFontSize(): number {
  return current
}

export function setTerminalFontSize(size: number): void {
  const next = clamp(size)
  if (next === current) return
  current = next
  try {
    localStorage.setItem(KEY, String(next))
  } catch {
    /* storage unavailable — the size just won't persist */
  }
  for (const cb of subscribers) cb(current)
}

/** Subscribe to LIVE size changes (no immediate replay — construction already read
 *  the current value; panes only need deltas). Returns unsubscribe. */
export function onTerminalFontSize(cb: (size: number) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

/**
 * How long a pane may wait for the terminal faces before it gives up and lets the grid
 * be measured against whatever is resolved. The faces are VENDORED, so this settles in
 * single-digit ms on a healthy boot and the bound only bites when the font pipeline is
 * broken — where it is the difference between "one pane measured a fallback" and "no
 * pane in the app is EVER measured, so no pty is ever sized and no deferred launch ever
 * types". It also caps app start: renderer/main.ts gates `start()` on the prime, and the
 * bare `fonts.load()` it replaces had no bound at all.
 */
const FONT_READY_MAX_WAIT_MS = 1500

let facesActive = false
let inFlight: Promise<void> | null = null

/**
 * Fire the one load of the terminal face set. Idempotent — first caller wins — and the
 * trigger for the metrics re-measure a pane must run (xterm caches its cell size, and
 * measured against a fallback face it renders wrong until told otherwise).
 *
 * `fonts.load()` and not `fonts.ready`: ready is a one-shot promise that can resolve
 * BEFORE a lazily-triggered face load has even started (CSS faces load on first use),
 * after which it never fires again — the old hook silently re-measured against the
 * fallback on any boot where the pane won that race. load() STARTS the load and
 * resolves on activation, which closes the race by construction. The symbols face is
 * unicode-range-scoped, so it must be asked for with a glyph inside its range — a bare
 * load would never fetch it.
 *
 * `inFlight` is set ONCE and never nulled, unlike machine-port's prime, which nulls on
 * catch so a transport hiccup can retry. There is nothing to retry here: allSettled
 * cannot reject and the bound guarantees settlement, so a second attempt could only
 * repeat work that already finished.
 */
export function primeTerminalFonts(): Promise<void> {
  if (facesActive) return Promise.resolve()
  if (!inFlight) {
    inFlight = new Promise<void>((resolve) => {
      const settle = (): void => {
        facesActive = true
        resolve()
      }
      const fonts = document.fonts
      if (!fonts?.load) return settle() // ancient environment: nothing to wait for
      const bound = setTimeout(settle, FONT_READY_MAX_WAIT_MS)
      const spec = `${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`
      void Promise.allSettled([
        fonts.load(`400 ${spec}`),
        fonts.load(`700 ${spec}`), // xterm renders bold cells with fontWeightBold
        fonts.load(`italic 400 ${spec}`),
        fonts.load(`${DEFAULT_TERMINAL_FONT_SIZE}px "MoggingLabs Symbols"`, '⠋')
      ]).then(() => {
        clearTimeout(bound)
        settle()
      })
    })
  }
  return inFlight
}

/**
 * Are the terminal faces active (or the bound spent)? THE readiness predicate for a
 * grid measurement: a cell measured while this is false was measured against a system
 * fallback, and a grid derived from it is wrong in BOTH axes — so it must never be
 * published to a pty. See pane-fit.ts's proposeGrid, which is the one gate.
 *
 * MONOTONIC by construction, and that is what makes it legal to gate on: a readiness
 * condition that can un-become-true (a pane's current renderer, say) forces you to
 * re-publish on every flip instead of deciding once.
 */
export function terminalFontsReady(): boolean {
  return facesActive
}

const doneSubscribers = new Set<() => void>()
let doneListenerArmed = false

/** Subscribe to LATE face activations (`fonts.loadingdone`) — any face landing after
 *  the initial await above still invalidates measured metrics. Returns unsubscribe. */
export function onFontsLoadingDone(cb: () => void): () => void {
  doneSubscribers.add(cb)
  if (!doneListenerArmed && document.fonts?.addEventListener) {
    doneListenerArmed = true
    document.fonts.addEventListener('loadingdone', () => {
      for (const sub of doneSubscribers) sub()
    })
  }
  return () => doneSubscribers.delete(cb)
}
