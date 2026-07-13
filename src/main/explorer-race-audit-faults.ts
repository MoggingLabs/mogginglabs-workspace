export interface ExplorerRaceAuditEvent {
  path: string
  stage: 'start' | 'finish'
  at: number
}

interface ExplorerRaceAuditState {
  delaysOnce: Record<string, number>
  events: ExplorerRaceAuditEvent[]
}

let state: ExplorerRaceAuditState | null = null

const fold = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value

export function setExplorerRaceAudit(delaysOnce: Record<string, number> | null): void {
  state = delaysOnce
    ? {
        delaysOnce: Object.fromEntries(
          Object.entries(delaysOnce).map(([path, delay]) => [fold(path), Math.max(0, Math.trunc(delay))])
        ),
        events: []
      }
    : null
}

export function explorerRaceAudit(): { events: ExplorerRaceAuditEvent[] } | null {
  return state
}

export async function waitForExplorerRaceAudit(path: string): Promise<void> {
  const active = state
  if (!active) return
  active.events.push({ path, stage: 'start', at: Date.now() })
  const key = fold(path)
  const delay = active.delaysOnce[key] ?? 0
  delete active.delaysOnce[key]
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  active.events.push({ path, stage: 'finish', at: Date.now() })
}

