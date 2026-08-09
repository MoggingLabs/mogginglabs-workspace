import type { PaneLaunchIntent } from '@contracts'

/**
 * What each live pane reports it is RUNNING — the pane's own launch intent, learned from the
 * daemon's `welcome` and kept for the life of the connection.
 *
 * THE PROBLEM THIS SOLVES. A relaunch resolves its profile as `named ?? whichever profile is
 * order 0 right now`, and the only durable record of a pane's profile was the workspace
 * manifest's slot entry — written ONLY when a launch named a profile explicitly. A launch
 * that took the default, and every hand-typed agent, left that slot null. So after a restart
 * the pane re-resolved order 0, and anything that had moved it since — activating another
 * profile, a newly discovered login landing at order 0 — silently brought the pane back on a
 * different config home than the one it had been running under.
 *
 * The pane's own intent does not have that problem: main RESOLVED it at launch and the daemon
 * persisted it, so it names the home the pane actually ran under whether or not anyone typed
 * the name. It outranks the manifest for exactly that reason.
 *
 * Main-side only. The renderer never sees `configDir` (ADR 0002 — profile env stays here).
 */
const byPane = new Map<number, PaneLaunchIntent>()

/** Record (or clear) a pane's reported launch intent. */
export function rememberPaneLaunch(paneId: number, intent: PaneLaunchIntent | undefined): void {
  if (intent) byPane.set(paneId, intent)
  else byPane.delete(paneId)
}

/** A pane's last reported launch intent, if the daemon told us one. */
export function paneLaunchFor(paneId: number): PaneLaunchIntent | undefined {
  return byPane.get(paneId)
}

/**
 * The profile a launch into this pane should use when the caller named none: the pane's own,
 * and only when it is for the SAME agent — a pane that ran claude says nothing about which
 * codex profile a codex launch belongs to.
 */
export function rememberedProfileFor(paneId: number | undefined, agentId: string): string | undefined {
  if (typeof paneId !== 'number') return undefined
  const intent = byPane.get(paneId)
  return intent && intent.agentId === agentId ? intent.profileId : undefined
}

/** Pane closed for good — a recycled id must not inherit its predecessor's profile. */
export function forgetPaneLaunch(paneId: number): void {
  byPane.delete(paneId)
}
