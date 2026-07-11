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
 *  not the pane's seed. POSIX reads it from the process itself (exact). Windows cannot read a
 *  process's cwd without native code, so it uses the pane's last reported cwd — which is why
 *  panes carry shell integration (backend/platform/shell.ts): cmd.exe now announces its
 *  directory on every prompt, so a `cd` inside the pane is reflected. The one case that stays
 *  out of reach there is a compound line — `cd sub && claude` — where the shell never prints a
 *  prompt between the two, so the agent's directory is one level below the last one reported.
 *  Its session log is then not found and the gauge stays on its honest "–" (everything else —
 *  the provider mark, the chip, resume — is unaffected). Guessing at descendants instead would
 *  risk locking on to a session belonging to another window, which is worse than no number.
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
