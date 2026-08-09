import type { PaneId } from '@contracts'
import type { PaneProfile } from './pane-profile'

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
  /** 'spawn': the pane does not exist yet — the controller emits this BEFORE building
   *  the grid so the agents feature can arm the command on the spawn-run port and the
   *  pane's spawn carries it (typed by the backend at spawn; no idle-prompt window).
   *  Omitted = typed delivery into a live pane (palette, restore, failover — and the
   *  automatic fallback when a spawn-run build is late or refused). */
  deliver?: 'spawn'
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
 * The profile a pane's agent is ACTUALLY running under, announced by whoever
 * RESOLVED it — a launch (which knows what it told main to build), a failover
 * relaunch, an adopt (which mostly knows that it does not know), a detection.
 * The `workspace` feature services it by writing that slot in the manifest, so
 * no restore ever has to guess.
 *
 * This replaces a failover-only event. A failover is not a special kind of
 * profile fact, and two events for one fact is precisely how the REQUESTED
 * profile and the RESOLVED profile came to be written by different code paths:
 * the manifest recorded the request (`profileId` above, "omitted = the
 * provider's default"), restore read it back as if it described an account, and
 * every blank slot got re-derived as order-0 on the way in.
 *
 * Ids only, no cross-feature imports — same decoupling rule as above.
 */
export interface PaneProfileEvent {
  paneId: PaneId
  provider: string
  profile: PaneProfile
}

const profileSubscribers = new Set<(ev: PaneProfileEvent) => void>()

export function announcePaneProfile(ev: PaneProfileEvent): void {
  for (const cb of profileSubscribers) cb(ev)
}

export function onPaneProfile(cb: (ev: PaneProfileEvent) => void): () => void {
  profileSubscribers.add(cb)
  return () => profileSubscribers.delete(cb)
}
