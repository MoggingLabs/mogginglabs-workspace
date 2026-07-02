import type { PaneId } from '@contracts'

/**
 * A request to launch an agent CLI into a pane. The `agents` feature (06) fulfils it — builds
 * the command, writes it into the pane, labels the pane; `provider === 'shell'` is a no-op.
 * The port lets `workspace` drive launches (on template open + restore) without importing
 * `agents`. No credentials — only a provider id + cwd (ADR 0002).
 */
export interface AgentLaunchRequest {
  paneId: PaneId
  provider: string
  cwd: string
  resume?: boolean
  /** Launch under this profile (Phase-4/04); omitted = the provider's default. */
  profileId?: string
}

const subscribers = new Set<(req: AgentLaunchRequest) => void>()

export function requestAgentLaunch(req: AgentLaunchRequest): void {
  for (const cb of subscribers) cb(req)
}

export function onAgentLaunchRequest(cb: (req: AgentLaunchRequest) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
