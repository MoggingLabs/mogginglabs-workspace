// The deterministic-interrupt DECISION core (profile switch, audit F2) — pure, so the
// unit tier can hold the trap detection and the budget without a terminal. The loop
// itself (interrupt.ts) owns the writes and the waits; everything here is a function
// of a buffer tail string.
//
// Why a trap answer exists at all: our launch path types `claude` / `codex` into a
// PowerShell pane, PowerShell resolves the npm shim through cmd.exe (`claude.cmd` is a
// batch file), and Ctrl+C mid-batch raises cmd's "Terminate batch job (Y/N)?" prompt —
// which EATS the next typed line. Unanswered, the resume command this interrupt exists
// to protect would be the line it eats. The smoke shell proved the recipe
// (smoke-shell.ts settleToShell); this is that recipe's production half.

/** One round = two ^C: the first cancels the CLI's current input, the second exits it.
 *  A CLI still booting has not installed its handler and ignores both — which is why
 *  the loop retries instead of trusting one round. */
export const INTERRUPT_ROUNDS = 4
/** Gap between the two ^C of a round (the smoke's proven cadence). */
export const DOUBLE_TAP_GAP_MS = 400
/** Per-round wait for the process-table gone verdict (promptSeen fast path is near
 *  instant; the liveness tick worst case is ~3s). */
export const GONE_WAIT_MS = 3000
/** After the verdict, the cmd prompt can appear AS node dies — sweep the trap a
 *  couple more times before declaring the pane typable. */
export const TRAP_SWEEP_TRIES = 2
export const TRAP_SWEEP_GAP_MS = 500
/** How many tail lines the trap scan reads. The prompt is the pane's LAST line when
 *  it is live; a deeper read only risks matching an old, already-answered trap. */
export const TRAP_TAIL_LINES = 6

/** Anchored at line end: a spent trap ("…(Y/N)? Y", the echoed answer) must not
 *  match — a second `Y\r` would land in whatever owns the keyboard next. */
const BATCH_TRAP = /Terminate batch job \(Y\/N\)\?$/i

/**
 * The keystrokes that answer a LIVE batch trap, or null when none is visible.
 * Only the last non-empty line counts: an answered trap higher in the scrollback
 * (its echoed `Y` on the next line) must never trigger a stray `Y` into a shell
 * prompt — that would type the letter into whatever owns the keyboard now.
 */
export function batchTrapAnswer(tail: string | null): string | null {
  if (!tail) return null
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    return BATCH_TRAP.test(line) ? 'Y\r' : null
  }
  return null
}
