/**
 * Auto-update UX. electron-updater checks the signed GitHub feed in packaged builds; main
 * pushes its lifecycle to the renderer over one channel so the UI can show the rail's update
 * row, a quiet titlebar dot, and a single "ready — restart?" toast.
 *
 * No update metadata ever enters telemetry (ADR 0005) — only booleans elsewhere.
 */

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  version?: string // the ready/available version (e.g. "0.4.0")
  percent?: number // 0-100 while downloading
  error?: string // human reason on 'error' (never a stack)
  /**
   * When a check last COMPLETED (epoch ms) — success or failure. The settings row exists to
   * answer "is this thing even running?", and only a timestamp can answer it: a feed whose
   * every download 404'd looked identical to a healthy one for nine releases, because `idle`
   * and `never actually checked` render the same. This is the difference.
   */
  lastCheckedAt?: number
  /** The running build, so the UI never has to guess what "up to date" means. */
  currentVersion?: string
  /** False in dev/smokes: there is no feed, so the UI must not claim to be up to date. */
  supported?: boolean
}

/**
 * The two update choices worth giving away. Deliberately NOT "turn off updates": an app that
 * lets you opt out of security fixes is an app full of users who did, silently, years ago.
 */
export interface UpdatePrefs {
  /** Receive pre-release tags (v1.0.0-beta.1). Off = stable only. */
  allowPrerelease: boolean
  /** Let a downloaded update apply on quit. Off = it only ever installs when asked. */
  installOnQuit: boolean
}

export const UPDATE_PREFS_DEFAULT: UpdatePrefs = {
  allowPrerelease: false,
  installOnQuit: true
}
