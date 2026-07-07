import { restartNeededPanes } from '@contracts'

// Live-pane tool-plan tracking (Phase-8/09, step 4/e). Each pane that launches
// an agent records the plan SIGNATURE it launched against; when the workspace's
// plan is edited, panes still holding an old signature are "restart-needed" —
// their running CLI won't pick up the new server set until relaunched. This is
// the data the matrix truth line + the restart nudge read (11 grows the chip).

const paneSigs = new Map<number, { workspaceId: string; sig: string }>()
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}

export function recordPaneLaunch(paneId: number, workspaceId: string, sig: string): void {
  paneSigs.set(paneId, { workspaceId, sig })
  emit()
}

export function clearPaneLaunch(paneId: number): void {
  if (paneSigs.delete(paneId)) emit()
}

/** The live panes in this workspace whose launch signature differs from
 *  `currentSig` — they need a restart to apply the plan. */
export function restartNeededPaneIds(workspaceId: string, currentSig: string): number[] {
  const panes = [...paneSigs.entries()]
    .filter(([, v]) => v.workspaceId === workspaceId)
    .map(([paneId, v]) => ({ paneId, launchSig: v.sig }))
  return restartNeededPanes(panes, currentSig)
}

export function onToolPlanPanesChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
