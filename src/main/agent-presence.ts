// Which panes actually run an AGENT, as far as main can know — the main-side twin of the
// renderer attention port's tracked gate (ALERTAGREE, 2026-07-18). The webhook bridge's
// `needs-you` used to read the raw daemon state stream, so a plain shell's bell (any BEL with
// no `done` behind it latches `attention` backend-side) fired an automation event over a pane
// whose dot, outline, rail and toasts all — correctly — said nothing. Every surface tells one
// story now: no agent, no alert, wire included.
//
// Presence is fed from BOTH directions, because each alone has a hole:
//   - the LAUNCH path (agents.ts marks a successful command build for its target pane): the
//     daemon's process detector takes seconds to confirm a fresh CLI, and a permission prompt
//     can beat it — launch-marking closes that lag. Remote launches mark too: their pane runs
//     an agent even though its verdict channel is chime-only.
//   - the DETECTION stream (daemon-relay's onAgent, agentId null = the agent left): covers
//     hand-typed CLIs the app never launched, and rebuilds presence on reattach — the daemon
//     replays each pane's detected agent on attach, so an app restart over a surviving daemon
//     re-learns who runs where without a single launch.
// A pane exit drops it (daemon-relay's onExit).
//
// RESIDUAL, accepted (the safe direction): a launch that never actually ran (the user ^C'd the
// typed command) leaves presence set until the pane exits or detection reports the agent gone —
// an extra webhook is a glance wasted; a dropped one is an agent waiting unheard. Ids only,
// never content (ADR 0002).

const present = new Set<number>()

/** Detection verdict (or launch intent): this pane runs / no longer runs an agent. */
export function notePaneAgent(paneId: number, hasAgent: boolean): void {
  if (hasAgent) present.add(paneId)
  else present.delete(paneId)
}

/** The pane's PTY exited — nothing runs there any more. */
export function notePaneGone(paneId: number): void {
  present.delete(paneId)
}

export function paneHasAgent(paneId: number): boolean {
  return present.has(paneId)
}
