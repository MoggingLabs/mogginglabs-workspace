/**
 * Auto-update UX (Phase-6/06). electron-updater checks the signed GitHub feed in
 * packaged builds; main pushes its lifecycle to the renderer over one channel so
 * the UI can show a quiet downloading dot and a single "ready — restart?" toast.
 * No update metadata ever enters telemetry (ADR 0005) — only booleans elsewhere.
 */

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  version?: string // the ready/available version (e.g. "0.4.0")
  percent?: number // 0-100 while downloading
  error?: string // human reason on 'error' (never a stack)
}
