import type { PtyEmulation } from '@contracts'

/**
 * Translate the pty's own report into xterm's `windowsPty` option. A pure function: the renderer
 * decides nothing here, it only re-shapes what backend/platform/pty-host.ts observed.
 *
 * WHY xterm must be told. ConPTY does not grow a terminal the way a unix pty does. When rows
 * increase, a unix pty pulls scrollback back down into the viewport; ConPTY instead appends EMPTY
 * rows at the bottom and leaves the scrollback where it is. Un-told, xterm takes the unix path
 * (`ybase--`) while ConPTY takes its own — and the two viewports are now offset by the rows they
 * disagreed about. That matters because ConPTY answers every resize with a full repaint (`ESC[H`,
 * then each row of conhost's screen buffer). Painted one row off, that repaint writes conhost's
 * *stale* rows — the shell prompts from before the agent launched — into the middle of the agent's
 * live TUI frame.
 *
 * `buildNumber` is a SECOND, independent threshold: xterm keeps modern reflow on at >= 21376
 * (those builds emit correct wrap sequences); below it, its conservative path disables reflow.
 * It is not the same constant that chose the backend — which is precisely why neither is
 * recomputed here.
 *
 * KNOWN STRUCTURAL LIMIT (do not chase as a renderer bug): a WIDTH shrink that re-wraps long
 * lines can ERASE up to a viewport's worth of recent output ("blank band in the middle of
 * the pane"). ConPTY's internal buffer is viewport-sized — scrollback exists only in xterm —
 * so conhost discards what its own re-wrap overflows and its answering repaint erases those
 * rows in xterm too. Measured identical with reflow on AND off (build 26200), so no value
 * of this option prevents it; only conhost keeping real scrollback would. The CONPTY gate's
 * width phase pins the bounded-band contract that DOES hold.
 */
export function windowsPtyFor(pty: PtyEmulation): { backend: 'conpty'; buildNumber: number } | undefined {
  return pty.backend === 'conpty' ? { backend: 'conpty', buildNumber: pty.buildNumber } : undefined
}
