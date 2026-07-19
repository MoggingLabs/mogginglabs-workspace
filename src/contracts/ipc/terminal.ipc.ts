import type { AgentState } from '../domain/agent'
import type { PaneCwdLocality, PaneCwdSource } from '../domain/cwd'
import type { PaneId } from '../domain/pane'

// Commands: UI -> backend
export interface SpawnRequest {
  id: PaneId
  cwd: string
  cols: number
  rows: number
  /** Trusted renderer context for least-privilege pane environment materialization.
   *  Missing/unknown values fail closed: no workspace-scoped secrets are injected. */
  workspaceId?: string
  /** The slot's assigned agent provider. Plain/unassigned shells receive no service keys. */
  agentId?: string
  /** Remote pane (4/05): host id — MAIN resolves the row; values stay main-side. */
  remoteHostId?: string
  /** Initial folder on the remote host; never probed or interpreted as a local path. */
  remoteCwd?: string
  /** A line the backend types into the fresh PTY the moment it spawns (the daemon's
   *  existing SpawnSpec.run seam) — the wizard lineup's launch command executes as the
   *  shell's first act, with no idle-prompt window. ONE-SHOT: ignored on reattach
   *  (the session is already running something), never recorded for reconnect replay,
   *  and never a credential — it is the same command string a launch would have typed
   *  (ADR 0002). Local panes only; a remote pane's launch stays typed after the SSH
   *  bootstrap proves the far-side shell. */
  run?: string
}

/** Private OSC emitted by the SSH bootstrap only after remote command execution starts. */
export const REMOTE_READY_OSC = '\x1b]777;mogging-remote-ready\x07'
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
  /** The workspace whose manifest confers the role — the swarm-role gate's counting
   *  scope (phase-accounts/05). The renderer cap and main's enforcement backstop share
   *  this denominator; counting globally in main while the renderer counted per
   *  workspace silently refused the second workspace's roles. */
  workspaceId: string
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
  /** The PTY session generation. Revisions are comparable only inside this generation. */
  generation: string
  /** Monotonic within this pane generation. A late event may not roll back a newer report. */
  revision: number
  source: PaneCwdSource
  locality: PaneCwdLocality
}

/** TYPED-LAUNCH DETECTION: an agent CLI process appeared in — or vanished from — this pane's
 *  PTY subtree. The backend knows this from the PROCESS TABLE (the pane's shell is its child,
 *  so the agent is its descendant), not from parsing terminal output: a user who types
 *  `claude` at the pane's own prompt gets the same session identity as an app-launched one
 *  (context gauge, provider mark, manifest resume) — the launch port only ever saw the
 *  launches the APP performed.
 *
 *  `agentId` is an adapter id ('claude', 'codex', …), or null when the pane's agent exited.
 *
 *  `cwd` is where the agent RUNS — it names the session log, so it is the agent's directory,
 *  not the pane's seed. POSIX reads it from the process itself. Windows snapshots the selected
 *  same-user descendant's process parameters with a read-only native helper and otherwise
 *  retains the pane's lower-priority shell cwd. Foreground ownership is established from the
 *  pane's process subtree plus terminal command/prompt boundaries; arbitrary executables do
 *  not gain a provider identity or resume capability merely because their cwd is observed.
 *
 *  `sinceMs` is when the agent was first seen (minus the detection lag): the floor a context
 *  watch may look back to for a session that predates it — which is every session after an app
 *  restart, since the daemon keeps the agent alive and replays this event on reattach.
 *
 *  Ids and counts only — never a command line (ADR 0002/0005). */
export interface AgentDetectedEvent {
  id: PaneId
  agentId: string | null
  cwd?: string
  sinceMs?: number
}
