import { statSync } from 'node:fs'
import { homedir } from 'node:os'

// Helpers BOTH PTY backends (the in-proc PtyService and the daemon's PaneSession) must
// agree on byte-for-byte. Each was duplicated per backend with a "mirrors the other"
// comment — but the two backends already share @backend modules, so one definition
// keeps the parity structural instead of hoped-for.

/** Retained per-pane output for reattach repaint — one cap, both backends. */
export const SCROLLBACK_BYTES = 200_000

/** How far past a fresh cap cut we'll look for a clean line start. */
const TEAR_SCAN = 400

/** A blind `.slice(-SCROLLBACK_BYTES)` can land mid escape sequence or between surrogate
 *  halves, and the reattach repaint then feeds xterm a sequence's tail as literal text (or
 *  a lone surrogate). Drop a split surrogate's low half, then cut forward to the next
 *  newline: at most one partial line of scrollback lost, cheap next to a garbled repaint.
 *  No newline nearby (one giant TUI frame) keeps the tear — same cap semantics either way. */
export function trimTornStart(s: string): string {
  const c0 = s.charCodeAt(0)
  if (c0 >= 0xdc00 && c0 <= 0xdfff) s = s.slice(1)
  const nl = s.indexOf('\n')
  return nl !== -1 && nl < TEAR_SCAN ? s.slice(nl + 1) : s
}

/** The directory a pane's shell starts in: the requested one when it is a real directory,
 *  the home directory otherwise. `''` means "none asked for" (never the process's own
 *  directory, which is the app's install folder in a packaged build), and a path removed
 *  since the workspace was saved falls back rather than failing the spawn. */
export function pickCwd(requested?: string): string {
  if (requested) {
    try {
      if (statSync(requested).isDirectory()) return requested
    } catch {
      /* gone, or not readable — fall through to home */
    }
  }
  return homedir()
}
