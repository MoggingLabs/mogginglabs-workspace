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
 */
export function windowsPtyFor(pty: PtyEmulation): { backend: 'conpty'; buildNumber: number } | undefined {
  return pty.backend === 'conpty' ? { backend: 'conpty', buildNumber: pty.buildNumber } : undefined
}
