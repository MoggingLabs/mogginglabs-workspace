export type BrowserRaceOperation =
  | 'navigate'
  | 'lastUrl'
  | 'profileGet'
  | 'profileSet'
  | 'consentGet'
  | 'consentApply'
  | 'signedInSites'
  | 'grantGet'

export interface BrowserRaceAuditEvent {
  operation: BrowserRaceOperation
  workspaceId: string
  stage: 'start' | 'finish'
  at: number
  value?: string
}

export interface BrowserRaceAuditState {
  delays: Record<string, number>
  events: BrowserRaceAuditEvent[]
}

let state: BrowserRaceAuditState | null = null

const key = (operation: BrowserRaceOperation, workspaceId: string): string => `${operation}:${workspaceId}`

export function setBrowserRaceAudit(delays: Record<string, number> | null): void {
  state = delays ? { delays: { ...delays }, events: [] } : null
}

export function browserRaceAudit(): BrowserRaceAuditState | null {
  return state
}

export async function waitForBrowserRaceAudit(
  operation: BrowserRaceOperation,
  workspaceId: string,
  value?: string
): Promise<void> {
  const active = state
  if (!active) return
  active.events.push({ operation, workspaceId, stage: 'start', at: Date.now(), value })
  const delay = Math.max(0, Math.trunc(active.delays[key(operation, workspaceId)] ?? 0))
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  active.events.push({ operation, workspaceId, stage: 'finish', at: Date.now(), value })
}

export function recordBrowserRaceAudit(
  operation: BrowserRaceOperation,
  workspaceId: string,
  value?: string
): void {
  const active = state
  if (!active) return
  const at = Date.now()
  active.events.push({ operation, workspaceId, stage: 'start', at, value })
  active.events.push({ operation, workspaceId, stage: 'finish', at, value })
}

