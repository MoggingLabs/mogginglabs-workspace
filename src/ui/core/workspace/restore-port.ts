import type { LastSessionInfo } from '@contracts'

/**
 * Restore-a-whole-session service. The `workspace` feature registers the restorer (it
 * owns the controller); Home's "Restore last working session" card calls it with the
 * payload `workspace:restoreSession` returned — every workspace of the previous
 * session, in the exact manifest shape the boot restore consumes. The restorer rebuilds
 * each workspace, relaunches its lineup with resume (the launch path resolves each
 * pane's EXACT session id from the intents that same invoke armed main-side), and
 * reveals the grid. Keeps `home` from reaching into `workspace` internals — the same
 * pattern as open-service next door.
 */
export interface SessionRestoreOutcome {
  /** Workspaces actually created by this call (an id already open is skipped, not duplicated). */
  restored: number
}

let restorer: ((info: LastSessionInfo) => SessionRestoreOutcome) | null = null

export function setSessionRestorer(fn: (info: LastSessionInfo) => SessionRestoreOutcome): void {
  restorer = fn
}

/** Rebuild the previous session. Null = the workspace feature isn't mounted (never in practice). */
export function restoreSession(info: LastSessionInfo): SessionRestoreOutcome | null {
  return restorer ? restorer(info) : null
}
