import type { AgentState } from '../domain/agent'
import type { PaneCwdLocality, PaneCwdSource } from '../domain/cwd'
import type { PaneId } from '../domain/pane'

// Commands: UI -> backend
export interface SpawnRequest {
  id: PaneId
  cwd: string
  /** The pane's MEASURED grid — absent when the pane could not measure (a hidden
   *  background workspace mounts display:none; its cells are unmeasurable). Dims flow
   *  one way, from a real measurement to the PTY: an invented 80×24 here resized a
   *  SURVIVING agent session to the wrong grid on every app restart (attachDims treats
   *  absent dims as "leave the session alone" — this is the field honoring it).
   *
   *  One way SETS; it does not mean one way KNOWS. SpawnResult reports the grid the
   *  session actually holds, so a client can tell agreement from divergence and heal the
   *  latter. Reporting is not measuring: a pane that could not measure adopts nothing. */
  cols?: number
  rows?: number
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
 * A full-screen TUI taking the terminal over: DEC private mode 1049 (or the older 1047/47)
 * SET. The CLIs emit it as part of mounting their interface, and for claude that is the
 * moment typed keystrokes stop being swallowed — measured, not assumed
 * (scripts/measure-agent-readiness.mjs; see the note in ui/core/terminal/liveness-port.ts).
 *
 * Shared because three layers must agree on the same bytes: the renderer scans the live
 * stream for it, the AGENTLAUNCH gate asserts a real CLI produces it, and any future
 * provider table records whether its CLI emits one at all.
 */
export const ALT_SCREEN_ENTER_RE = /\x1b\[\?(?:1049|1047|47)h/
/** Longest prefix of an alt-screen sequence that a chunk boundary can split (`\x1b[?1049`). */
export const ALT_SCREEN_ENTER_MAX_PREFIX = 8
/**
 * An SGR (colour/style) sequence — the cheapest proof that a TUI has actually PAINTED
 * rather than merely negotiated. Taking the alternate screen happens a beat before the
 * first frame, so readiness needs both: the takeover and a frame drawn into it.
 */
export const SGR_RE = /\x1b\[[0-9;]*m/
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
  /** The session GENERATION this spawn bound to (daemon path; the in-proc backend has no
   *  generations). The pane echoes it on write/resize so a stale sender — a disposed
   *  pane's late timer, a reused id's previous occupant — can be REFUSED at the daemon
   *  instead of resizing/typing into the successor session (ConPTY answers every applied
   *  resize with a full repaint, so a stale resize is a smear, not a no-op). */
  gen?: number
  /** The grid the SESSION holds, read back after the backend applied whatever this spawn
   *  asked for. Absent from an older daemon, and absent is not zero — a caller that cannot
   *  see the session's size must assert nothing.
   *
   *  This is the answer to the one-way rule at the top of this file, not an exception to
   *  it. Dims still flow one way — only a real client measurement ever SETS a size — but
   *  the session now REPORTS what it holds, which is what makes a divergence detectable.
   *  Without it, a resize dropped between the renderer and ConPTY (a session that did not
   *  exist yet, a dead socket, a tombstoned generation) was permanent and silent: nothing
   *  compared the two sides, and the only re-assert in the app rides the daemon-reconnect
   *  edge, which a boot-time drift never crosses. */
  cols?: number
  rows?: number
}
export interface WriteCommand {
  id: PaneId
  data: string
  /** The sender's session generation (see SpawnResult.gen). Absent = ungated legacy/
   *  in-proc sender; present-and-stale = dropped by the daemon. */
  gen?: number
}
export interface ResizeCommand {
  id: PaneId
  cols: number
  rows: number
  /** See WriteCommand.gen. */
  gen?: number
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
 *  `sinceMs` is when the agent PROCESS started — its creation time where the platform reports
 *  one, first-seen minus the detection lag otherwise: the floor a context watch may look back
 *  to for a session that predates it. Process start (not first-seen) is what survives an app
 *  restart: the daemon keeps the agent alive and replays this event on reattach, and a floor
 *  collapsed to "restart time" would hide an idle session's log for hours. A materially
 *  different sinceMs for the same pane means a DIFFERENT process — an in-pane relaunch.
 *
 *  Ids and counts only — never a command line (ADR 0002/0005). */
export interface AgentDetectedEvent {
  id: PaneId
  agentId: string | null
  cwd?: string
  sinceMs?: number
}
