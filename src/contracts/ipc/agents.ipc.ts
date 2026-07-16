// Agent-launcher contract (Phase-1/06). The app builds a launch COMMAND only; the CLI
// self-authenticates (ADR 0002). No credentials ever cross this boundary — only agent ids,
// a cwd, and the resulting command string.

import type { AgentCliId, AgentExecutionTarget } from '../domain/agent-cli'

/** An agent CLI + whether it's installed (on PATH). */
export interface AgentInfo {
  id: AgentCliId
  name: string
  installed: boolean
  /** The provider's own install one-liner. Copyable everywhere; Settings § Providers
   *  can also RUN it on an explicit click, in an ephemeral background pty
   *  (agents:install). It is never parsed, edited, or elevated. */
  installHint?: string
}

// ── Provider installs (Settings § Providers) ────────────────────────────────
// The install runs in an ephemeral pty: the user's own shell, backgrounded,
// with the provider's documented one-liner injected as typed input. The verdict
// is a RE-DETECT (is the bin on PATH now?), not the shell's exit code — PATH
// presence is the same truth `installed` above is built from.

export type AgentInstallPhase = 'running' | 'succeeded' | 'failed'

/** Live/last-known state of one provider's background install. */
export interface AgentInstallState {
  agentId: AgentCliId
  phase: AgentInstallPhase
  /** Bounded tail of the ephemeral terminal's output (ANSI stripped — plain text). */
  tail: string
  /** The shell's exit code — informational only; the verdict is the re-detect. */
  exitCode?: number
  startedAt: number
  endedAt?: number
}

/** Answer to agents:install — whether the background install actually started. */
export interface AgentInstallStart {
  ok: boolean
  reason?: string
}

/** Request the launch command for an agent in a directory. */
export interface AgentCommandRequest {
  agentId: AgentCliId
  cwd: string
  /** Omitted by legacy callers means local; config reconciliation refuses ssh targets. */
  execution?: AgentExecutionTarget
  resume?: boolean
  /** Launch under this profile's env pointers (Phase-4/04). */
  profileId?: string
  /** The pane this command will be typed into. Lets main resume the pane's EXACT
   *  session (the context monitor's locked log names it) when a resume launch crosses
   *  profiles — a failover relaunch continues the conversation instead of opening the
   *  CLI's picker (ADR 0013). Ids only; never required. */
  paneId?: number
  /** Materialize this workspace's tool plan into the launch (Phase-8/09) —
   *  the pane's CLI gets only the planned servers. */
  workspaceId?: string
  /** When present, main resolves the saved target and builds for its shell dialect. */
  remoteHostId?: string
  /** The command is typed into the POSIX shell on the far side of SSH. */
  remote?: boolean
}

/** A failed source-of-truth reconciliation must be visible, never a silent null launch. */
export interface AgentCommandResult {
  ok: boolean
  command?: string
  /** Honest launch refusal (unknown agent, missing remote, or scoped-plan conflict). */
  reason?: string
  /** Local launches only: the profile declares an email but its config home
   *  disagrees — nobody signed in yet (no `actual`), or a different account
   *  (`actual` names it). The profile email is a label the app cannot enforce
   *  (the CLI's own OAuth picks whatever the browser session offers), so the
   *  facts surface at the moment they bite. Never blocks the launch. */
  signIn?: { expected: string; actual?: string }
}
