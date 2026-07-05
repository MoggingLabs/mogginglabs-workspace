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

/**
 * Usage-limit failover switched a pane to another profile (Phase-6/04). The
 * `workspace` feature services this by rewriting that slot in the workspace
 * manifest — otherwise the next restart would resurrect the capped profile.
 * Same decoupling rule as above: ids only, no cross-feature imports.
 */
export interface ProfileFailoverEvent {
  paneId: PaneId
  profileId: string
}

const failoverSubscribers = new Set<(ev: ProfileFailoverEvent) => void>()

export function announceProfileFailover(ev: ProfileFailoverEvent): void {
  for (const cb of failoverSubscribers) cb(ev)
}

export function onProfileFailover(cb: (ev: ProfileFailoverEvent) => void): () => void {
  failoverSubscribers.add(cb)
  return () => failoverSubscribers.delete(cb)
}
