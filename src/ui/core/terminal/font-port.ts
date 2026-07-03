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
