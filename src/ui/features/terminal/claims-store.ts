import { LedgerChannels, type Claim, type PaneId } from '@contracts'
import { getBridge } from '../../core/ipc/bridge'
import { workspaceIdForPane } from '../../core/workspace/workspace-info-port'

/**
 * Renderer mirror of the daemon's ownership ledger (Phase-4/02). Fed ENTIRELY by
 * pushes over the relay (`ledger:owners` on every change — zero polling); read by
 * each TerminalPane for its claims chip + "Show claims…" modal. Claim patterns are
 * paths: they render in the UI and go nowhere else (never telemetry — ADR 0005).
 */
let claims: Claim[] = []
const subs = new Set<() => void>()
let inited = false

export function initClaims(): void {
  if (inited) return
  inited = true
  getBridge().on(LedgerChannels.owners, (payload) => {
    claims = (payload as { claims?: Claim[] })?.claims ?? []
    for (const cb of subs) cb()
  })
}

export function claimsFor(paneId: PaneId): Claim[] {
  return claims.filter((c) => c.paneId === String(paneId))
}

/** Everything claimed in this pane's workspace (the referee's full map). Grouped by the
 *  workspace that HOLDS each pane, not by its id: a pane that moved workspaces keeps its
 *  id, so `id / 100` would file its claims under the workspace it left — and the referee
 *  would show two agents, working side by side, two different maps. */
export function workspaceClaims(paneId: PaneId): Claim[] {
  const wsId = workspaceIdForPane(Number(paneId))
  if (!wsId) return []
  return claims.filter((c) => workspaceIdForPane(Number(c.paneId)) === wsId)
}

export function onClaimsChange(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

/** Dev/smoke fixture seam. Production builds compile this guard to a no-op; real
 *  claims still enter exclusively through the daemon-owned ledger push above. */
export function setClaimsForDev(next: Claim[]): void {
  if (!import.meta.env.DEV) return
  claims = [...next]
  for (const cb of subs) cb()
}
