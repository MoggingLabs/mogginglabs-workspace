export interface DaemonHealthState {
  mode: 'starting' | 'daemon' | 'in-process'
  state: 'starting' | 'connected' | 'reconnecting' | 'degraded'
  /** Human, non-secret status copy suitable for a persistent banner. */
  message: string
  /** Whether panes can survive an app/main-process restart in this mode. */
  sessionSurvival: boolean
}

export interface RuntimeHealthRetryResult {
  ok: boolean
  reason?: string
}
