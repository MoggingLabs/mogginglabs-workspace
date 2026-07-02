import type { AgentState } from '../domain/agent'
import type { PaneId } from '../domain/pane'

// Commands: UI -> backend
export interface SpawnRequest {
  id: PaneId
  cwd: string
  cols: number
  rows: number
  /** Remote pane (4/05): host id — MAIN resolves the row; values stay main-side. */
  remoteHostId?: string
}
export interface WriteCommand {
  id: PaneId
  data: string
}
export interface ResizeCommand {
  id: PaneId
  cols: number
  rows: number
}
export interface KillCommand {
  id: PaneId
}

/** Swarm manifest (Phase-4/01): name a pane's role on the daemon. */
export interface SetRoleCommand {
  id: PaneId
  role: string
}

// Events: backend -> UI
export interface DataEvent {
  id: PaneId
  data: string
}
export interface ExitEvent {
  id: PaneId
  exitCode: number
}
export interface StateEvent {
  id: PaneId
  state: AgentState
}
export interface CwdEvent {
  id: PaneId
  cwd: string
}
