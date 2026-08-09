/**
 * Degraded-restore port: the `terminal` feature learns from its spawn reply that a pane came
 * back having lost its launch settings; the `agents` feature is the one that can say what to
 * do about it (mark the pane, offer the relaunch). Neither imports the other — same rule as
 * the spawn-run and liveness ports next door.
 *
 * Late-subscriber safe, and it has to be: the spawn reply can land before the agents feature
 * has mounted its listener, and a marker dropped on the floor is a pane that silently passes
 * for a plain shell — exactly the failure this whole path exists to end. Reports arriving
 * before anyone listens are held and replayed on subscribe.
 */

const pending = new Map<number, string>()
let sink: ((paneId: number, agentId: string) => void) | null = null

/** The terminal feature's report: this pane restored degraded, and here is what it ran. */
export function reportLaunchDegraded(paneId: number, agentId: string): void {
  if (sink) sink(paneId, agentId)
  else pending.set(paneId, agentId)
}

/** The agents feature's subscription. Replays anything reported before it mounted. */
export function onLaunchDegraded(fn: (paneId: number, agentId: string) => void): void {
  sink = fn
  for (const [paneId, agentId] of pending) fn(paneId, agentId)
  pending.clear()
}

/** Pane closed for good — a recycled id must not inherit a predecessor's marker. */
export function forgetLaunchDegraded(paneId: number): void {
  pending.delete(paneId)
}
