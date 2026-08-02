/**
 * A pane's per-SESSION-LIFE state, in one object.
 *
 * A pane id outlives the shells that run in it: `restart()` respawns a dead pane under the
 * SAME id, and the daemon's `ensure()` respawns a removed id on reconnect. So every latch a
 * pane keeps has to answer "which life does this belong to?" — and the ones that belong to a
 * life must all die together, or the new shell inherits the old one's conclusions.
 *
 * They did not. `restart()` re-armed `captureEmitted` with the comment "a restarted pane is a
 * NEW session life" — the law, stated correctly, on one field. Three others sat beside it:
 *
 *   liveMarked        latched true, so the respawned shell's first output never re-marked the
 *                     pane live — every lineup launch waiting on `whenPaneLive` would fall
 *                     through on its timeout instead of firing on the output.
 *   remoteReadyMarked latched true, so the far side's readiness OSC was ignored forever after.
 *   remoteReadyProbe  kept a partial OSC match from the previous shell's output, which can
 *                     complete against the next shell's first bytes.
 *
 * The bug being fixed is the port half (a restarted remote pane read as remote-READY before
 * SSH had authenticated, because the mark survived). But clearing the port ALONE turns that
 * into "never ready", because these latches then suppress the re-mark. The two halves are one
 * fix, which is the argument for one object: a new per-life latch is reset by construction,
 * not by remembering a third site.
 *
 * Deliberately NOT here: `capturedThrough` (the capture ladder spans lives — scrollback
 * survives a restart, and re-capturing what a prior life already sent would duplicate it) and
 * `replayCopyGraceUntil` (re-armed on every spawn reply, which is a finer grain than a life).
 */
export interface PaneLife {
  /** The pane has produced PTY output in THIS life — gates the one `markPaneLive` call. */
  liveMarked: boolean
  /** The far-side shell reported readiness past SSH auth in THIS life. */
  remoteReadyMarked: boolean
  /** Partial match carried across PTY chunk boundaries while scanning for the readiness OSC. */
  remoteReadyProbe: string
  /** The one session-end capture emission (revision C): exit and close race, whichever fires
   *  first sends the ladder and the other finds this latched. */
  captureEmitted: boolean
}

export function freshPaneLife(): PaneLife {
  return { liveMarked: false, remoteReadyMarked: false, remoteReadyProbe: '', captureEmitted: false }
}
