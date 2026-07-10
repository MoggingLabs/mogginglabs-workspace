import type { AgentState, PaneId } from '@contracts'

/**
 * Per-pane agent state, aggregated for "which agent needs me" indicators. Each `TerminalPane`
 * publishes its OSC state here; the `workspace` feature aggregates per workspace into a tab
 * outline/badge, and the app raises a dock/taskbar badge. A ui-core port so those features stay
 * decoupled from `terminal`. Primitives only — never PTY content (ADR 0002/0005).
 *
 * Also owns the STICKY FINISHED flag (explicit direction: "green can only go to idle
 * after I click that pane"). Derived HERE, at the single gate every state transition
 * passes through, so every consumer — the pane dot, the rail badge/outline, the grid
 * pulses — reads one truth and can never disagree:
 *   set      on the finished edge: the pane WAS working or blocked (busy/attention)
 *            and went idle — it stopped, and you haven't looked at it yet.
 *   cleared  by `acknowledgeFinished` (a real click on the pane — grid-layout wires
 *            it), by NEW work (busy/attention reclaims the pane), or with the pane
 *            itself (`clearPaneState` on dispose — pane ids are reused, and a flag
 *            that outlived its pane would mark the successor as finished).
 */
/** A non-idle episode must OUTLIVE repaint noise to count as finished work. Real
 *  shells emit short output bursts with no work behind them — prompt repaints on
 *  reveal/resize, xterm auto-replies (CPR/DA/focus) — and each one is a busy→idle
 *  round of exactly burst + the tracker's 1.5s quiet window ≈ 1.6s. Without this
 *  floor, every workspace switch would stamp every pane "finished". 2.5s clears
 *  the noise band with margin; genuinely quick commands (an instant `ls`) fall
 *  under it by design — there is nothing to come back for. */
const MIN_WORK_MS = 2500

const states = new Map<PaneId, AgentState>()
const finished = new Set<PaneId>()
const episodeStart = new Map<PaneId, number>()
const subscribers = new Set<() => void>()

const notify = (): void => {
  for (const cb of subscribers) cb()
}

export function setPaneState(paneId: PaneId, state: AgentState): void {
  const prev = states.get(paneId) ?? 'idle'
  if (prev === state) return
  states.set(paneId, state)
  if (state === 'idle') {
    // prev was busy/attention (the early-return above guarantees it): the episode
    // ends — it counts as finished work only if it lasted like work.
    const start = episodeStart.get(paneId)
    episodeStart.delete(paneId)
    if (start !== undefined && Date.now() - start >= MIN_WORK_MS) finished.add(paneId)
  } else {
    if (prev === 'idle') episodeStart.set(paneId, Date.now()) // episode begins
    finished.delete(paneId)
  }
  notify()
}

/** The pane was clicked: its sticky finished (green) dot is dismissed. */
export function acknowledgeFinished(paneId: PaneId): void {
  if (finished.delete(paneId)) notify()
}

export function paneFinished(paneId: PaneId): boolean {
  return finished.has(paneId)
}

export function clearPaneState(paneId: PaneId): void {
  const hadFlag = finished.delete(paneId)
  episodeStart.delete(paneId)
  if (states.delete(paneId) || hadFlag) notify()
}

export function paneState(paneId: PaneId): AgentState {
  return states.get(paneId) ?? 'idle'
}

export function onAttentionChange(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
