import { app, ipcMain, type BrowserWindow } from 'electron'
import { WorkspaceChannels } from '@contracts'

// App-wiring: the OS-level attention signal (macOS dock badge; Windows/Linux taskbar flash).
// The renderer aggregates per-pane verdicts into TWO booleans (one refreshAttention pass,
// workspace/controller.ts) and main owns the one fact the renderer cannot: whether the window
// is actually focused. Booleans only — never PTY content (ADR 0002/0005).

export interface AttentionFlags {
  /** A BACKGROUND workspace holds an unseen alert (red latched, or an unacked green). */
  background: boolean
  /** The ACTIVE workspace holds an unseen alert — visible only if the window itself is. */
  active: boolean
}

/** The signal policy, pure for the gate (attention-smoke asserts the truth table).
 *
 *  Background workspaces ring regardless of window focus — you cannot see them by definition.
 *  The ACTIVE workspace rings only while the window is NOT focused: minimized, or behind
 *  another app. That closes the gap this module shipped with (found in the 2026-07-18 review):
 *  "you can see the one you are looking at" was the rationale for background-only, and it is
 *  simply untrue of a minimized window — a single-workspace user who minimized the app got no
 *  OS signal at all when their agent blocked. Focused again, the active half falls silent (the
 *  outline and dot are on screen; the OS has nothing to add). */
export function attentionSignal(flags: AttentionFlags, windowFocused: boolean): boolean {
  return flags.background || (flags.active && !windowFocused)
}

/** Legacy boolean payloads (a stale renderer mid-update) read as the old meaning: background
 *  only. Anything malformed reads as all-quiet — a wrong flash is noise, a stuck one is worse. */
function normalize(payload: unknown): AttentionFlags {
  if (typeof payload === 'boolean') return { background: payload, active: false }
  const p = payload as { background?: unknown; active?: unknown } | null
  return { background: p?.background === true, active: p?.active === true }
}

let sawActive = false

/** Did any renderer publish an active-workspace alert this run? The live half of the gate:
 *  proves the {background, active} payload actually crosses the wire (a reverted renderer
 *  sending the old boolean can never set it). */
export function attentionSawActiveForSmoke(): boolean {
  return sawActive
}

export function registerAttention(getWindow: () => BrowserWindow | null): void {
  let flags: AttentionFlags = { background: false, active: false }
  let wired: BrowserWindow | null = null
  const apply = (): void => {
    const win = getWindow()
    // Focus listeners attach lazily (the window may postdate registration) and exactly once
    // per window — apply() re-runs on every focus edge so the active half can fall silent
    // the moment the user is back.
    if (win && wired !== win) {
      wired = win
      win.on('focus', apply)
      win.on('blur', apply)
    }
    const on = attentionSignal(flags, win ? win.isFocused() : true)
    if (process.platform === 'darwin') {
      app.dock?.setBadge(on ? '●' : '')
      return
    }
    win?.flashFrame(on)
  }
  ipcMain.on(WorkspaceChannels.attention, (_e, payload: unknown) => {
    flags = normalize(payload)
    if (flags.active) sawActive = true
    apply()
  })
}
