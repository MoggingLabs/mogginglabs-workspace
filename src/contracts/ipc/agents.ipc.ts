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

// ── One-click setup (the guided path) ───────────────────────────────────────
//
// `agents:install` above types a one-liner into a shell and hopes. That is fine when the
// machine is already set up and useless when it is not — which is exactly the machine a
// first-time user is on. The real first run went: the CLI wasn't there, so npm was needed;
// npm wasn't there, so Node was needed; Node's installer changed PATH, which the running
// app could not see; and the global install wanted permissions the user didn't have. Four
// walls, each of which reads as "this app is broken".
//
// Setup is the same destination with every wall handled: probe what's here, bootstrap the
// runtime through the OS package manager, put the global bin somewhere that needs no admin,
// repair PATH (this process AND the user's own), install, then VERIFY by re-detecting.
//
// It installs. It never signs in — you cannot log a CLI in before it has a terminal, so
// sign-in is a separate, later moment (see AgentSignInTarget) and ADR 0002 still holds:
// the app types the provider's own command and never handles a credential.

export type AgentSetupStepId = 'probe' | 'runtime' | 'permissions' | 'path' | 'install' | 'verify'

export type AgentSetupStepPhase = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface AgentSetupStep {
  id: AgentSetupStepId
  /** Plain language, in the user's terms — "Install Node.js", not "bootstrap runtime". */
  label: string
  phase: AgentSetupStepPhase
  /** What happened, one line. Present on done/skipped/failed. */
  note?: string
  /** What the user can DO about a failure. Only ever set with phase 'failed' — a failure
   *  the app cannot explain how to fix is a failure it should not have reported this way. */
  remedy?: string
}

export type AgentSetupPhase = 'running' | 'succeeded' | 'failed'

export interface AgentSetupState {
  agentId: AgentCliId
  phase: AgentSetupPhase
  steps: AgentSetupStep[]
  /** Bounded plain-text transcript of every command setup ran — the thing to paste into a
   *  bug report. Terminal output stays local (ADR 0005); it is never telemetry. */
  tail: string
  startedAt: number
  endedAt?: number
}

export interface AgentSetupStart {
  ok: boolean
  reason?: string
}

/** What the sign-in banner types, and where. Derived from the provider's own documented
 *  verb — `inSession` when its CLI is already running in the pane, `shell` when the pane
 *  is a bare prompt. A provider that authenticates by API key has neither, and is never
 *  offered a banner. */
export interface AgentSignInTarget {
  agentId: AgentCliId
  name: string
  inSession?: string
  shell?: string
}

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
  /**
   * Nobody is signed in at the config home this launch will use — so the pane should
   * OFFER a sign-in rather than let the user find out from the CLI.
   *
   * This is the half `signIn` above never covered: that field only speaks when a PROFILE
   * declares an email to compare against, which is precisely not the situation a
   * first-time user is in. They install a CLI, a workspace opens, and the terminal shows
   * whatever that CLI does when it has no credentials — which for most is a prompt with no
   * indication that the app knew, or that one click would fix it.
   *
   * Carries the provider's own login verb (ADR 0002): the app types it into a pane the
   * user is watching, and that is the entire extent of its involvement in auth.
   */
  needsSignIn?: AgentSignInTarget
}

/** Global agent alert wiring (AgentHookChannels) — the hand-typed-launch gap, per CLI. */
export type GlobalHookProvider = 'claude' | 'codex' | 'gemini' | 'opencode'

export interface GlobalHooksProviderStatus {
  provider: GlobalHookProvider
  /** 'applied' = every entry current; 'partial' = ours present but stale or incomplete
   *  (Re-apply); 'conflict' = the user's OWN config occupies a slot we would need (codex's one
   *  `notify`, a differing tui value) — writes refuse and `reason` names the line;
   *  'unreadable' = a file we will not faithfully rewrite (JSONC comments, junk). */
  state: 'applied' | 'partial' | 'not-applied' | 'conflict' | 'unreadable'
  /** The user-owned config file(s) the state was read from. */
  files: string[]
  reason?: string
  /** False when the user explicitly REMOVED this provider's wiring (Settings, or the
   *  undo toast): detection must not re-apply what a human deliberately took out. An
   *  explicit Apply clears the opt-out. Absent = never opted out (auto-wire may act). */
  autoWire?: boolean
}

/** `agentHooks:status` answers one row per provider, in catalog order. */
export type GlobalHooksStatus = GlobalHooksProviderStatus[]

export interface GlobalHooksMutationResult {
  ok: boolean
  reason?: string
  /** Timestamped copies of the bytes replaced, when writes happened over existing content. */
  backups?: string[]
}
