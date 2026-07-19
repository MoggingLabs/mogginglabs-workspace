import type { AgentState, PaneId } from '@contracts'
import { recordCompletion, clearCompletions } from './completions'

/**
 * Per-pane agent state, aggregated for "which agent needs me" indicators. Each `TerminalPane`
 * publishes its verdict here; the `workspace` feature aggregates per workspace into the rail's
 * counts and outline, the `notify` feature turns transitions into toasts, and the app raises a
 * dock/taskbar badge. A ui-core port so those features stay decoupled from `terminal`.
 * Primitives only — never PTY content (ADR 0002/0005).
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
 * The ACK is the sticky half (explicit direction: "green can only go to idle after I click that
 * pane"), and it lives here rather than on the backend because it is a fact about the USER, not
 * about the agent. It is dropped by any new state — new work reclaims the pane — and with the
 * pane itself on dispose: pane ids are REUSED, and an ack that outlived its pane would silently
 * swallow its successor's first green.
 *
 * THE TRACKED GATE (ALERTAGREE, 2026-07-18). The port only holds state for panes whose session
 * the app wired end-to-end — an agent CLI it launched, or one typed at the prompt and adopted by
 * detection. Plain shells and `custom:<cmd>` panes stay OUT: their tracker still runs backend-
 * side (it is provider-agnostic), but a bare BEL in a plain shell used to reach the toast layer
 * through the raw relay and announce "needs your input" over a pane whose dot, outline and rail
 * all — correctly — said nothing. The gate used to live as a private side effect inside
 * TerminalPane (its dot skipped untracked events), which is exactly how the surfaces came to
 * disagree: gated truth for the readers of this port, raw truth for everyone else. It is the
 * PORT's law now (explicit direction: alerts are the agent story, everywhere or nowhere), fed by
 * core/attention/tracking.ts from the agent-session port, so a consumer of this port CANNOT read
 * an untracked pane's state — there is none to read.
 *
 * Transitions (`onPaneStateTransition`) fire from the same single state gate, so anything
 * event-shaped (the toast layer) inherits the gate and the dedup for free: one gate, one truth,
 * no surface can disagree with another.
 */

const states = new Map<PaneId, AgentState>()
/** Panes whose `done` the user has already looked at. Only ever meaningful while the state IS
 *  `done`; any other state drops the entry (see setPaneState). */
const acked = new Set<PaneId>()
/** Panes whose session the app can speak for (see the TRACKED GATE above). Kept here, not in
 *  TerminalPane: every consumer of this port inherits it, or the surfaces drift apart again. */
const tracked = new Set<PaneId>()
const subscribers = new Set<() => void>()
const transitionSubs = new Set<(paneId: PaneId, next: AgentState, prev: AgentState) => void>()

const notify = (): void => {
  for (const cb of subscribers) cb()
}

/** Declare whether this pane's agent session is one the app wired end-to-end. Wired from the
 *  agent-session port by core/attention/tracking.ts (the ONE writer); the dev smokes drive it
 *  directly. Flipping to untracked drops everything the pane held — an untracked pane must not
 *  keep ringing a rail it can no longer justify. */
export function setPaneTracked(paneId: PaneId, isTracked: boolean): void {
  if (isTracked) {
    tracked.add(paneId)
    return
  }
  if (!tracked.has(paneId)) return
  clearPaneState(paneId)
}

/** Whether the port will accept state for this pane — the dot's availability question. */
export function paneTracked(paneId: PaneId): boolean {
  return tracked.has(paneId)
}

export function setPaneState(paneId: PaneId, state: AgentState): void {
  // THE TRACKED GATE: an untracked pane's verdicts fall on the floor here, for every consumer
  // at once. (The daemon's tracker runs for every pane — a plain shell's BEL still becomes an
  // `attention` event on the wire — but no alert surface may repeat a claim the pane itself is
  // not allowed to wear.)
  if (!tracked.has(paneId)) return
  const prev = states.get(paneId) ?? 'unknown'
  if (prev === state) return
  states.set(paneId, state)
  // The TRANSITION into `done` is the completion, and this is the one gate every state change
  // passes through — so the history is written exactly once per finished turn. A green is meant
  // to be spent (you click it and it is gone); without this, "what did my agents get done while
  // I was away" had no answer at all once you had dismissed them.
  if (state === 'done') recordCompletion(paneId)
  // Anything that is not `done` reclaims the pane: the agent is working, blocked, or has settled
  // without finishing, and in every one of those cases last turn's acknowledgement is spent. The
  // NEXT done is a new green and must be able to earn its halo.
  if (state !== 'done') acked.delete(paneId)
  // Event-shaped consumers (toasts) ride the SAME gate as the snapshot readers — emitted before
  // the aggregate notify so a transition handler that reads the port sees the new truth.
  for (const cb of transitionSubs) cb(paneId, state, prev)
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
  // The tracked flag goes with the state. Pane ids are REUSED (a disposed pane's id returns on
  // the next workspace with that ordinal), and a stale tracked entry would let a successor's
  // plain shell ring the rail before any session justified it.
  tracked.delete(paneId)
  // The history goes with the pane. Pane ids are REUSED, and a successor inheriting these would
  // be showing you someone else's work under its own name.
  clearCompletions(paneId)
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

/** Per-pane state TRANSITIONS, from the one gate every change passes through — already deduped
 *  (same-state re-applies never fire) and already tracked-gated. The toast layer consumes this
 *  instead of the raw terminal:state relay, which is what makes a toast structurally incapable
 *  of disagreeing with the pane it names (ALERTAGREE). */
export function onPaneStateTransition(
  cb: (paneId: PaneId, next: AgentState, prev: AgentState) => void
): () => void {
  transitionSubs.add(cb)
  return () => transitionSubs.delete(cb)
}
