import type { AgentSessionEnd } from '../../core/agents/agent-session-port'

// The deterministic-interrupt DECISION core (profile switch, audit F2) — pure, so the
// unit tier can hold the trap detection, the budget and the gone-evidence rule without a
// terminal. The loop itself (interrupt.ts) owns the writes and the waits; everything here
// is a function of a buffer tail string or of a session-end reason.
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

/**
 * Does this session END prove the pane's agent is gone — i.e. may the caller now TYPE?
 *
 * The interrupt's whole claim is that nothing is written into a pane whose agent might
 * still be alive, and it settles that on the process table's verdict. But the agent
 * SESSION is retired by more than a verdict, and every one of those clears used to reach
 * the interrupt as "gone" — including the weakest of them, the shell's own OSC 133;D/A
 * prompt mark. That one is not evidence about the agent at all: it says the SHELL is
 * prompting, which is true of a backgrounded agent, of a mark replayed from scrollback,
 * and of a ^C at an idle prompt. The backend has always known this — agent-proc.ts's
 * `promptSeen` spends a process listing rather than trust a prompt — while the renderer
 * quietly promoted the same guess to a verdict.
 *
 * That is what made the PROFSWITCH fail-closed gate flaky: one macOS failure in a full
 * 215-gate sweep (2026-08-03) where the interrupt reported GONE 520ms in — ~120ms after
 * its second ^C, far too fast for a process listing — and typed the relaunch into an
 * agent nothing had ever said was dead. The macOS trigger itself was not captured (that
 * runner is not reproducible here); what IS proven is the shape: firing a 133;D at the
 * interrupt on Windows reproduces that trace phase for phase, and no longer does. It fits
 * the platform and the load: only macOS because a zsh/bash with third-party shell
 * integration emits real 133 marks (ours are 633), and only under load because
 * terminal-pane's post-session grace swallows a mark inside its first 1500ms — a slow run
 * is what puts the ^C outside that window.
 *
 * A guess may still hide the context bar. It may not authorize a keystroke.
 */
export function endProvesAgentGone(end: AgentSessionEnd): boolean {
  return end === 'exited' || end === 'verdict' || end === 'pane-gone'
}

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
