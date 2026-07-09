import type { PaneId } from '@contracts'

/**
 * Per-pane agent SESSION identity: which CLI a pane launched, where, and under which
 * profile. WRITER: the `agents` feature, on every launch path (fresh, restore, adopt,
 * failover relaunch). READER: the `context` feature, which turns it into a session-log
 * watch for the pane's context bar. A port so the two never import each other — the
 * same pattern as pane-meta/pane-cwd next door. IDs only: the profile field is the
 * profile's id, never its env values (ADR 0002).
 */
export interface PaneAgentSession {
  /** Provider id as launched ('claude', 'codex', 'gemini', 'custom:<cmd>'…). */
  provider: string
  /** The cwd the agent LAUNCHED in (the session log is keyed on it — not the live
   *  OSC-7 cwd, which follows the shell around after the agent exits). */
  cwd: string
  profileId?: string
  /** Pane adopted from the detached daemon — its session predates this app run. */
  adopted?: boolean
}

const sessions = new Map<PaneId, PaneAgentSession>()
const subscribers = new Set<(paneId: PaneId, session: PaneAgentSession | null) => void>()

export function setPaneAgentSession(paneId: PaneId, session: PaneAgentSession): void {
  sessions.set(paneId, session)
  for (const cb of subscribers) cb(paneId, session)
}

export function clearPaneAgentSession(paneId: PaneId): void {
  if (!sessions.delete(paneId)) return
  for (const cb of subscribers) cb(paneId, null)
}

export function getPaneAgentSession(paneId: PaneId): PaneAgentSession | undefined {
  return sessions.get(paneId)
}

/** Subscribe to session changes. Current values are replayed immediately. */
export function onPaneAgentSession(cb: (paneId: PaneId, session: PaneAgentSession | null) => void): () => void {
  subscribers.add(cb)
  for (const [id, s] of sessions) cb(id, s)
  return () => subscribers.delete(cb)
}
