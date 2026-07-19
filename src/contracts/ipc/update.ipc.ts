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
  /**
   * The last completed check could not REACH the network (DNS down, no route, mid-network
   * change) — as opposed to reaching a feed that is broken. Offline is a fact about the
   * machine, not the updater: a background check that fails this way stays out of
   * `phase: 'error'` entirely (quiet `idle` + this flag), because one wake-from-sleep DNS
   * blip used to latch the rail's red "Update failed — retry" for the full six-hour tick
   * (found live, v0.14.0). Only a human-initiated check surfaces an offline failure, and
   * this flag is what lets settings say "you look offline" instead of "the updater broke".
   */
  offline?: boolean
}

/**
 * Payload for UpdateChannels.check. `auto: true` marks a machine-initiated re-check (the
 * renderer's online-recovery poke) — offline failures from those stay quiet, exactly like
 * the boot and six-hour checks. No payload = a human asked; failures answer honestly.
 */
export interface UpdateCheckRequest {
  auto?: boolean
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
