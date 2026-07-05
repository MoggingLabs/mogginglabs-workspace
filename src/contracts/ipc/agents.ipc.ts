// Agent-launcher contract (Phase-1/06). The app builds a launch COMMAND only; the CLI
// self-authenticates (ADR 0002). No credentials ever cross this boundary — only agent ids,
// a cwd, and the resulting command string.

/** An agent CLI + whether it's installed (on PATH). */
export interface AgentInfo {
  id: string
  name: string
  installed: boolean
  /** The provider's own install one-liner — a copyable HINT only; the app never
   *  runs it (6/06 checklist + wizard empty state). */
  installHint?: string
}

/** Request the launch command for an agent in a directory. */
export interface AgentCommandRequest {
  agentId: string
  cwd: string
  resume?: boolean
  /** Launch under this profile's env pointers (Phase-4/04). */
  profileId?: string
}
