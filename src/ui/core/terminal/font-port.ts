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
 * Resolves when the terminal's faces are ACTIVE — the trigger for the one metrics
 * re-measure a pane must run (xterm caches its cell size; measured against a fallback
 * face it renders wrong until told).
 *
 * `fonts.load()` and not `fonts.ready`: ready is a one-shot promise that can resolve
 * BEFORE a lazily-triggered face load has even started (CSS faces load on first use),
 * after which it never fires again — the old hook silently re-measured against the
 * fallback on any boot where the pane won that race. load() STARTS the load and
 * resolves on activation, which closes the race by construction. The symbols face is
 * unicode-range-scoped, so it must be asked for with a glyph inside its range — a bare
 * load would never fetch it.
 */
export async function terminalFontsActive(): Promise<void> {
  const fonts = document.fonts
  if (!fonts?.load) return // ancient environment: nothing to wait for, measure as-is
  const spec = `${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`
  await Promise.allSettled([
    fonts.load(`400 ${spec}`),
    fonts.load(`700 ${spec}`), // xterm renders bold cells with fontWeightBold
    fonts.load(`italic 400 ${spec}`),
    fonts.load(`${DEFAULT_TERMINAL_FONT_SIZE}px "MoggingLabs Symbols"`, '⠋')
  ])
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
