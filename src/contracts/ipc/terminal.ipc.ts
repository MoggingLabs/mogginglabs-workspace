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
/**
 * How the pty backing a pane behaves when its viewport grows. ConPTY appends empty rows at the
 * bottom and leaves scrollback alone; a unix pty pulls scrollback back down. xterm must be told
 * which, or the two viewports drift and ConPTY's repaint-on-resize writes stale rows into the
 * live frame. Produced ONLY by backend/platform/pty-host.ts, alongside the pty it describes —
 * never inferred renderer-side. `buildNumber` gates xterm's reflow (correct only at >= 21376).
 */
export type PtyEmulation = { backend: 'posix' } | { backend: 'conpty'; buildNumber: number }

/** Answer to a SpawnRequest. `existing` means the backend ALREADY held a live session for
 *  this pane id and reattached us to it rather than starting a shell — the normal case
 *  when the detached daemon (ADR 0006) outlived the app. Callers must not then type a
 *  launch command into the pane: whatever was running is still running, and the text
 *  would land in ITS stdin, not a shell prompt.
 *
 *  `restored` narrows `existing`: the session exists but is a cold-start RESTORE — a fresh
 *  shell repainting persisted scrollback, untouched since (no live agent, nothing typed).
 *  The two must be distinguishable or resume breaks in one direction or the other: typing
 *  `claude --resume` into a truly-live reattach lands in the running agent's stdin, while
 *  NOT typing it into a restored pane leaves a dead agent behind painted history. Callers
 *  treat `existing && !restored` as "hands off" and `restored` as "safe to resume into".
 *
 *  `pty` rides this answer because it must reach xterm before the first byte of output does,
 *  and spawn is the one message that is always awaited before a pane is used. */
export interface SpawnResult {
  existing: boolean
  restored: boolean
  pty: PtyEmulation
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

/** State-sync PULL (the dot's reliability contract): a pane asks for its CURRENT
 *  agent state when it mounts. Events alone cannot keep the dot honest — the daemon
 *  pushes state only on CHANGE, the spawn ack carries none, and a welcome replay
 *  fired before the pane's listener existed is simply lost (renderer reload, app
 *  boot against a surviving daemon). Answer is the live state, or null when the
 *  backend holds no session for the id. */
export interface StateSyncRequest {
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
