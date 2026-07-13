import { AgentChannels, type AgentInfo, type AgentInstallState } from '@contracts'
import { getBridge } from '../ipc/bridge'

type Listener = (agents: readonly AgentInfo[]) => void

let snapshot: AgentInfo[] = []
let initialized = false
let refreshInFlight: Promise<readonly AgentInfo[]> | null = null
const listeners = new Set<Listener>()

const sameRoster = (a: readonly AgentInfo[], b: readonly AgentInfo[]): boolean =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index]
    return !!other &&
      item.id === other.id &&
      item.name === other.name &&
      item.installed === other.installed &&
      item.installHint === other.installHint
  })

function publish(next: AgentInfo[]): void {
  const ordered = [...next].sort((a, b) => a.id.localeCompare(b.id))
  if (sameRoster(snapshot, ordered)) return
  snapshot = ordered
  for (const listener of listeners) listener(snapshot)
}

function initialize(): void {
  if (initialized) return
  initialized = true
  const refresh = (): void => {
    if (document.visibilityState === 'visible') void refreshAgentRegistry()
  }
  getBridge().on(AgentChannels.installChanged, (payload) => {
    const state = payload as AgentInstallState
    if (state.phase !== 'running') void refreshAgentRegistry()
  })
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  // Covers a CLI installed/uninstalled in an already-open external terminal.
  setInterval(refresh, 15_000)
}

/** Re-detect once, coalescing simultaneous consumers onto the same IPC call. */
export function refreshAgentRegistry(): Promise<readonly AgentInfo[]> {
  initialize()
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (getBridge().invoke(AgentChannels.detect) as Promise<AgentInfo[]>)
    .then((agents) => {
      publish(Array.isArray(agents) ? agents : [])
      return snapshot
    })
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

export function getAgentRegistry(): readonly AgentInfo[] {
  initialize()
  return snapshot
}

/** Subscribe to the app-wide availability map. The first subscriber starts detection. */
export function onAgentRegistryChange(listener: Listener): () => void {
  initialize()
  listeners.add(listener)
  if (snapshot.length) queueMicrotask(() => listener(snapshot))
  else void refreshAgentRegistry()
  return () => listeners.delete(listener)
}
