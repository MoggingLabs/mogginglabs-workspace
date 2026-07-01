import type { AgentState, PaneId } from '@contracts'

/**
 * Per-pane agent state, aggregated for "which agent needs me" indicators. Each `TerminalPane`
 * publishes its OSC state here; the `workspace` feature aggregates per workspace into a tab
 * ring/badge, and the app raises a dock/taskbar badge. A ui-core port so those features stay
 * decoupled from `terminal`. Primitives only — never PTY content (ADR 0002/0005).
 */
const states = new Map<PaneId, AgentState>()
const subscribers = new Set<() => void>()

const notify = (): void => {
  for (const cb of subscribers) cb()
}

export function setPaneState(paneId: PaneId, state: AgentState): void {
  if (states.get(paneId) === state) return
  states.set(paneId, state)
  notify()
}

export function clearPaneState(paneId: PaneId): void {
  if (states.delete(paneId)) notify()
}

export function paneState(paneId: PaneId): AgentState {
  return states.get(paneId) ?? 'idle'
}

export function onAttentionChange(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
