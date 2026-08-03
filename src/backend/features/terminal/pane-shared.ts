import { mergeEnvFolding } from '@backend/platform/env-path'
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

/**
 * The most characters ONE write may hand a pty.
 *
 * A pty's input queue is a fixed kernel buffer, and the SMALLEST of them is what is safe
 * everywhere: Darwin caps it at TTYHOG = 1024 bytes (xnu `bsd/sys/tty.h`) where Linux's
 * n_tty line discipline holds 4096, and Windows' ConPTY has no such queue at all. A write
 * larger than that queue is NOT flow-controlled the way a pipe is — once the queue fills,
 * the line discipline DROPS the excess (BSD `ttyinput`, Linux `n_tty_receive_buf`). No
 * error surfaces anywhere: the reader simply receives a silently truncated line.
 *
 * That is not theoretical. The app types a whole composed first prompt into a pane in ONE
 * write (board launch hand-off), and REPOMAP_DEFAULT_BUDGET budgets its fenced blocks to
 * 4000 characters before the fences and the task are added — FOUR TIMES Darwin's queue,
 * and inside Linux's by a couple of dozen characters. The prompt is a fenced
 * ```repomap block, so losing any part of its closing fence unbalances the backticks and
 * leaves the pane's shell at a PS2 continuation prompt, where every later command typed
 * into that pane is swallowed as more of the unfinished one — a pane that echoes input and
 * runs nothing, with no error to read anywhere. (BRAINMILESTONE's macos-only red, run
 * 30737193862: "pane 201 MCP bridge timed out" — the bridge command went into the
 * continuation, so the bridge process was never started and nothing ever connected.)
 *
 * 512 leaves a full chunk inside the smallest queue with room for whatever is already in
 * it. Paced delivery is the caller's half of the contract — see the daemon's writePty.
 */
export const PTY_INPUT_CHUNK_CHARS = 512

/**
 * Split pane input into writes no larger than the smallest pty input queue.
 *
 * Never splits a surrogate pair: each chunk is encoded on its own, so half a pair would
 * reach the pty as U+FFFD and the character would be lost as surely as the truncation this
 * exists to prevent.
 */
export function chunkPtyInput(data: string, size = PTY_INPUT_CHUNK_CHARS): string[] {
  if (!data) return []
  if (data.length <= size) return [data]
  const out: string[] = []
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + size, data.length)
    if (end < data.length) {
      const last = data.charCodeAt(end - 1)
      // A high surrogate at the boundary belongs with the low half in the NEXT chunk —
      // unless backing up would empty this one, which no sane `size` can reach.
      if (last >= 0xd800 && last <= 0xdbff && end - 1 > i) end -= 1
    }
    out.push(data.slice(i, end))
    i = end
  }
  return out
}

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
 *
 * TWO of these sequences MOVE THE CURSOR, and this string is appended directly after the
 * replayed history — so the fresh prompt painted over row 0 of the history it was meant to
 * follow.
 *
 *   `?1049l` calls restoreCursor. With no prior DECSC — and there is none, the history came
 *   from a process that is gone — that restores to (0,0). `?1047l` leaves the alt screen
 *   WITHOUT touching the cursor, which is the whole reason both codes exist.
 *
 *   A default `ESC [ r` sets the scroll region to the full screen AND homes the cursor, per
 *   DECSTBM. Wrapped in DECSC/DECRC (`ESC 7` … `ESC 8`) the position is saved and restored.
 *
 * DECRC also restores SGR, so the region reset sits BEFORE the trailing `ESC [ m` — after it,
 * it would undo it.
 */
export const RESTORE_MODE_RESET =
  '\x1b[?1047l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8\x1b[m'

/**
 * Compose a pane's environment. THE composer — both backends call this, or they drift.
 *
 * Windows environment variable names are case-INSENSITIVE to look up but case-SENSITIVE
 * as object keys, and `process.env` on Windows spells it `Path`. So layering an overlay
 * that spells it `PATH` with a plain object spread leaves BOTH keys present, and node-pty
 * emits its pairs in insertion order with no folding (terminal.js `_parseEnv`), so the
 * process receives two PATH definitions and Windows takes the first — the inherited,
 * stale one. Every live-PATH repair the app performs was landing in the losing key: the
 * newly installed agent stayed invisible to its own pane.
 *
 * mergeEnv (backend/platform/env-path.ts) has always known how to do this — it deletes a
 * base key whose name differs from an overlay key only by case. It was simply applied to
 * the LAST overlay only, while everything above it was spread in by hand, in two separate
 * backends. macOS has a single `PATH` key, so nothing there ever failed and no gate saw it.
 *
 * Routing the whole composition through mergeEnv is the fix: an overlay carrying `PATH`
 * now folds away the inherited `Path` on its way in.
 */
export function paneProcessEnv(
  base: NodeJS.ProcessEnv,
  ...overlays: (Record<string, string | undefined> | undefined)[]
): NodeJS.ProcessEnv {
  return composePaneEnv(process.platform === 'win32', base, ...overlays)
}

/** paneProcessEnv with the fold decided by the caller, so the Windows-only behavior can be
 *  asserted on every runner. Without this the one platform that exhibits the bug is the
 *  only one whose CI could catch it — which is how it survived to ship. */
/**
 * Claude Code's session-NESTING markers — the vars it exports to its OWN child
 * processes so a claude spawned inside claude knows it is nested. When THIS APP is
 * launched from a terminal inside a Claude Code session (the everyday dev workflow),
 * every pane inherited them, and a claude launched in a pane believed it was a nested
 * child: `CLAUDE_CODE_CHILD_SESSION` made it TURN TRANSCRIPT SAVING OFF — silently
 * breaking resume, session pooling and the whole profile-failover continuity story
 * (found live 2026-08-02: the switched pane's picker said "No conversations found"
 * because the capped session had never been written). A pane here is a fresh
 * terminal, not part of whatever session launched the app, so these claims are
 * factually wrong in it. NAMED markers only — a user's own config (API keys, config
 * dirs, `CLAUDE_CODE_OAUTH_TOKEN`) is never touched.
 */
const CLAUDE_NESTING_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
])

export function composePaneEnv(
  foldCase: boolean,
  base: NodeJS.ProcessEnv,
  ...overlays: (Record<string, string | undefined> | undefined)[]
): NodeJS.ProcessEnv {
  const merged = mergeEnvFolding(foldCase, base, ...overlays)
  // Windows env names are case-insensitive to look up — delete by normalized name so
  // an inherited casing variant cannot survive (same rule as stripLocalPaneCapabilities).
  for (const key of Object.keys(merged)) {
    if (CLAUDE_NESTING_MARKERS.has(key.toUpperCase())) delete merged[key]
  }
  return merged
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
