import type { PaneId } from '@contracts'

/**
 * A request to launch an agent CLI into a pane. The `agents` feature (06) fulfils it — builds
 * the command, writes it into the pane, labels the pane; `provider === 'shell'` is a no-op.
 * The port lets `workspace` drive launches (on template open + restore) without importing
 * `agents`. No credentials — only a provider id + cwd (ADR 0002).
 *
 * THE ONE LAUNCH SEAM: every user-facing launch path (wizard lineup, restore, palette,
 * pane ⋯ menu) must go THROUGH this port, because `workspace` also subscribes and records
 * each request as that slot's manifest assignment + launch cwd. A launch that side-steps
 * the port still works live but is invisible to the manifest: on the next restart the
 * daemon-surviving agent reattaches with no session identity — no context bar, no agent
 * chip, no resume on a cold daemon. (The failover relaunch is the sanctioned exception:
 * it re-launches a provider the port already recorded, and announces its profile switch
 * on the dedicated event below.)
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
