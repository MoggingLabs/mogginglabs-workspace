import type { PaneId } from '@contracts'

/**
 * Per-pane agent SESSION identity: which CLI runs in a pane, where, and under which
 * profile. WRITER: the `agents` feature — on every launch path (fresh, restore, adopt,
 * failover relaunch) AND on typed-launch DETECTION, the backend's process-table verdict
 * for agents the app never launched. READER: the `context` feature, which turns it into a
 * session-log watch for the pane's context bar; the `workspace` feature, which records a
 * detected session as that slot's manifest assignment. A port so none of them import each
 * other — the same pattern as pane-meta/pane-cwd next door. IDs only: the profile field is
 * the profile's id, never its env values (ADR 0002).
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
  /** DETECTED, not launched: the user typed the CLI at the pane's own prompt and the backend
   *  found its process in the pane's PTY subtree. The session is as real as any other — it
   *  simply arrived without the app's help, so its cwd is the agent's own (a hint that may
   *  be refined DOWN a directory) and it carries no profile the app chose. */
  detected?: boolean
  /** RUNNING, not merely launched: the backend has SEEN this agent's process in the pane's PTY
   *  subtree. A launch writes this session the moment it types the command into the shell — the
   *  CLI has not started yet, and for a second or two the pane is a shell with a command in
   *  flight. `detected` cannot carry that difference: it answers WHO started the agent, not
   *  WHETHER it is up. So anything that must hand something TO the agent waits for this instead
   *  — the board's card task, which IS the agent's first prompt: typed a beat too early it lands
   *  in the shell behind a booting CLI, which wipes the screen when it takes it, and the task is
   *  gone. A detected session is running by definition; a launched one is confirmed when the
   *  process table shows it (or never, for a CLI nothing can detect — those keep a fallback). */
  running?: boolean
  /** When this session was first known to exist (ms epoch). Detection reports it exactly;
   *  the log matcher uses it as the floor for how far back this pane's session log may lie. */
  since?: number
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
