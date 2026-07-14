import type { AgentState, PaneId } from '@contracts'

/**
 * Per-pane agent state, aggregated for "which agent needs me" indicators. Each `TerminalPane`
 * publishes its verdict here; the `workspace` feature aggregates per workspace into the rail's
 * counts and outline, and the app raises a dock/taskbar badge. A ui-core port so those features
 * stay decoupled from `terminal`. Primitives only — never PTY content (ADR 0002/0005).
 *
 * THE FINISHED FLAG used to be DERIVED here, and that was the bug. It watched for a busy->idle
 * EDGE and, if the episode had lasted longer than a 2.5-second floor, called it a completion —
 * which meant it could not tell an explicit `Stop` hook from "the terminal went quiet". Typing a
 * prompt slowly greened a pane. So did switching workspaces (the refit resizes the pty and
 * ConPTY repaints the whole viewport). So did an agent pausing on a slow tool call.
 *
 * There is no derivation left. The backend now emits `done` as a state of its own, raised by an
 * explicit completion verdict and by nothing else (contracts/domain/agent.ts). "Finished" is
 * simply that state, minus an acknowledgement:
 *
 *     finished  ==  state is `done`  AND  the user has not clicked the pane
 *
 * No edge, no episode clock, no duration floor — a done is a done whether the task took thirty
 * seconds or three hundred milliseconds.
 *
 * The ACK is the sticky half (explicit direction: "green can only go to idle after I click that
 * pane"), and it lives here rather than on the backend because it is a fact about the USER, not
 * about the agent. It is dropped by any new state — new work reclaims the pane — and with the
 * pane itself on dispose: pane ids are REUSED, and an ack that outlived its pane would silently
 * swallow its successor's first green.
 */

const states = new Map<PaneId, AgentState>()
/** Panes whose `done` the user has already looked at. Only ever meaningful while the state IS
 *  `done`; any other state drops the entry (see setPaneState). */
const acked = new Set<PaneId>()
const subscribers = new Set<() => void>()

const notify = (): void => {
  for (const cb of subscribers) cb()
}

export function setPaneState(paneId: PaneId, state: AgentState): void {
  const prev = states.get(paneId) ?? 'unknown'
  if (prev === state) return
  states.set(paneId, state)
  // Anything that is not `done` reclaims the pane: the agent is working, blocked, or has settled
  // without finishing, and in every one of those cases last turn's acknowledgement is spent. The
  // NEXT done is a new green and must be able to earn its halo.
  if (state !== 'done') acked.delete(paneId)
  notify()
}

/** The pane was clicked (or landed on): its sticky green is dismissed. */
export function acknowledgeFinished(paneId: PaneId): void {
  if (states.get(paneId) !== 'done' || acked.has(paneId)) return
  acked.add(paneId)
  notify()
}

/** Finished AND unacknowledged — the green halo, the green outline, the rail's done count. */
export function paneFinished(paneId: PaneId): boolean {
  return states.get(paneId) === 'done' && !acked.has(paneId)
}

export function clearPaneState(paneId: PaneId): void {
  const hadAck = acked.delete(paneId)
  if (states.delete(paneId) || hadAck) notify()
}

/** `unknown` for a pane that has never spoken a verdict — NOT `idle`. The difference is the
 *  whole point: idle is a claim ("nothing is running"), unknown is the absence of one ("this
 *  agent's hooks have never reached us, so we will not pretend to know"). It renders hollow. */
export function paneState(paneId: PaneId): AgentState {
  return states.get(paneId) ?? 'unknown'
}

export function onAttentionChange(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
