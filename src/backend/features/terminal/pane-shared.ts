import { statSync } from 'node:fs'
import { homedir } from 'node:os'

// Helpers BOTH PTY backends (the in-proc PtyService and the daemon's PaneSession) must
// agree on byte-for-byte. Each was duplicated per backend with a "mirrors the other"
// comment — but the two backends already share @backend modules, so one definition
// keeps the parity structural instead of hoped-for.

/** Retained per-pane output for reattach repaint — one cap, both backends. CHARACTERS,
 *  not bytes (`.slice` on a JS string counts UTF-16 code units); the old `_BYTES` name
 *  silently overstated the cap for any multi-byte output. The PERSISTED tail is smaller
 *  on purpose — see PERSISTED_SCROLLBACK_CHARS in workspace/session-store.ts. */
export const SCROLLBACK_CHARS = 200_000

/** How far past a fresh cap cut we'll look for a clean line start. */
const TEAR_SCAN = 400

/** How far we'll look for a sequence boundary when no newline is near — a full-screen
 *  TUI frame (CUP/EL redraws) can run kilobytes without one `\n`, but rarely more than a
 *  few dozen characters without an ESC. */
const TEAR_SCAN_SEQ = 4096

/**
 * A blind `.slice(-SCROLLBACK_CHARS)` can land mid escape sequence or between surrogate
 * halves, and the reattach repaint then feeds xterm a sequence's tail as literal text
 * (or a lone surrogate). Drop a split surrogate's low half, then cut forward to the
 * EARLIEST clean boundary:
 *
 *   - past the next newline (the line-output fast path — at most one partial line lost);
 *   - or to the next ESC. This is what saves TUI frames, which emit no `\n` for
 *     kilobytes: a torn sequence's REMAINDER can never contain another ESC (an ESC
 *     inside CSI aborts it; an OSC/DCS payload admits ESC only as its ST terminator, and
 *     cutting there keeps `ESC \` — a ground-state no-op). So the first ESC in the tail
 *     is provably the start of a complete sequence, and everything before it is the torn
 *     fragment that would have printed as garbage.
 *
 * Neither boundary within its window (one giant sequence-free text block) keeps the
 * tear — plain text tears render as plain text, same cap semantics either way.
 */
export function trimTornStart(s: string): string {
  const c0 = s.charCodeAt(0)
  if (c0 >= 0xdc00 && c0 <= 0xdfff) s = s.slice(1)
  const nl = s.indexOf('\n')
  const nlCut = nl !== -1 && nl < TEAR_SCAN ? nl + 1 : -1
  const esc = s.indexOf('\x1b')
  const escCut = esc !== -1 && esc < TEAR_SCAN_SEQ ? esc : -1
  if (nlCut !== -1 && (escCut === -1 || nlCut <= escCut)) return s.slice(nlCut)
  if (escCut !== -1) return s.slice(escCut)
  return s
}

/**
 * Terminal-mode normalizer appended after a RESTORED pane's replayed history, before its
 * fresh shell's first byte. The history was recorded from a process that may have died
 * holding alt-screen, mouse reporting, bracketed paste, a scroll region, or a hidden
 * cursor — and the ring trims from the HEAD, so the sequence that would have exited a
 * mode is exactly what survives while its enter was trimmed (or vice versa). The fresh
 * shell behind a restored pane enabled NONE of them, so ground state is the truth here;
 * this never touches a live reattach, whose process still owns its modes.
 */
export const RESTORE_MODE_RESET =
  '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[r\x1b[m'

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
